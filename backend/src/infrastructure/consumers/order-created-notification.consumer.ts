import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { CONSUMERS_CONFIG, ConsumersConfig } from './consumers.config';

// Topology (declared idempotently at startup):
//   orders --(order.created)--> order.created.notifications  (main)
//   main --nack--> default exchange --> order.created.notifications.retry (TTL) --> back to main
//   poison / unrecoverable --> order.created.notifications.dlq (terminal)
const EXCHANGE = 'orders';
const ROUTING_KEY = 'order.created';
const QUEUE = 'order.created.notifications';
const RETRY_QUEUE = 'order.created.notifications.retry';
const DLQ = 'order.created.notifications.dlq';
const CONSUMER = 'order.notifications';

type ProcessOutcome = 'enqueued' | 'duplicate' | 'skipped';

/**
 * First production consumer. Consumes order.created and enqueues an
 * "order received" notification into NotificationOutbox. The notification row and
 * the ProcessedEvent dedup row are written in one transaction (exactly-once
 * enqueue). Delivery is a later, separate sender phase.
 */
@Injectable()
export class OrderCreatedNotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OrderCreatedNotificationConsumer');
  private channel: amqp.Channel | null = null;
  private consumerTag: string | null = null;
  private stopped = false;
  private reinitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    @Inject(CONSUMERS_CONFIG) private readonly config: ConsumersConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('Consumers disabled (CONSUMERS_ENABLED=false)');
      return;
    }
    if (!this.config.rabbitmqUrl) {
      this.logger.warn('Consumers enabled but RABBITMQ_URL is not set; consumer idle');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    try {
      if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
    } catch {
      // best-effort
    }
    try {
      if (this.channel) await this.channel.close();
    } catch {
      // best-effort
    }
    this.channel = null;
  }

  private async start(): Promise<void> {
    try {
      const channel = await this.rabbit.createConsumerChannel(this.config.prefetch);
      await this.declareTopology(channel);
      channel.on('close', () => this.handleChannelClose());
      channel.on('error', (err: Error) => this.logger.error(`consumer channel error: ${err.message}`));
      const { consumerTag } = await channel.consume(
        QUEUE,
        (msg) => {
          if (msg) void this.handleDelivery(channel, msg);
        },
        { noAck: false },
      );
      this.channel = channel;
      this.consumerTag = consumerTag;
      this.logger.log(`Consuming ${QUEUE}`);
    } catch (err) {
      this.logger.error(`Failed to start consumer: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReinit();
    }
  }

  private async declareTopology(channel: amqp.Channel): Promise<void> {
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(DLQ, { durable: true });
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-message-ttl': this.config.retryDelayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUE,
      },
    });
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': RETRY_QUEUE },
    });
    await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  }

  async handleDelivery(channel: amqp.Channel, msg: amqp.ConsumeMessage): Promise<void> {
    const messageId = msg.properties.messageId;
    if (!messageId) {
      this.deadLetter(channel, msg, 'missing messageId');
      return;
    }

    let event: { name?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(msg.content.toString());
    } catch {
      this.deadLetter(channel, msg, 'unparseable body');
      return;
    }

    try {
      await this.process(messageId, event);
      channel.ack(msg); // enqueued | duplicate | skipped are all "handled"
    } catch (err) {
      if (isUniqueViolation(err)) {
        channel.ack(msg); // concurrent duplicate
        return;
      }
      const deaths = countDeaths(msg);
      if (deaths >= this.config.maxAttempts) {
        this.deadLetter(channel, msg, err);
      } else {
        channel.nack(msg, false, false); // → retry queue (TTL) → back to main
      }
    }
  }

  /** Dedup + enqueue. ProcessedEvent insert shares the tx → exactly-once enqueue. */
  async process(messageId: string, event: { name?: string; payload?: Record<string, unknown> }): Promise<ProcessOutcome> {
    const seen = await this.prisma.processedEvent.findUnique({
      where: { consumer_messageId: { consumer: CONSUMER, messageId } },
    });
    if (seen) return 'duplicate';

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`order.created without orderId (messageId=${messageId}); skipping`);
      return 'skipped';
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!order || !order.user?.email) {
      this.logger.warn(`order/recipient missing for order ${orderId}; skipping`);
      return 'skipped';
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.create({
          data: {
            channel: NotificationChannel.EMAIL,
            recipient: order.user!.email,
            template: 'order.received',
            payload: {
              orderId,
              orderNumber: event.payload?.orderNumber ?? null,
              totalPrice: event.payload?.totalPrice ?? null,
              customerName: order.user!.name,
            },
            sourceMessageId: messageId,
          },
        });
        await tx.processedEvent.create({
          data: { consumer: CONSUMER, messageId, eventName: event.name ?? 'order.created' },
        });
      });
      return 'enqueued';
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err; // transient → caller retries
    }
  }

  private deadLetter(channel: amqp.Channel, msg: amqp.ConsumeMessage, reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.logger.error(`Dead-lettering order.created delivery: ${message}`);
    channel.sendToQueue(DLQ, msg.content, {
      ...msg.properties,
      headers: { ...(msg.properties.headers ?? {}), 'x-dead-letter-reason': message },
    });
    channel.ack(msg);
  }

  private handleChannelClose(): void {
    this.channel = null;
    this.consumerTag = null;
    if (!this.stopped) {
      this.logger.warn('Consumer channel closed; scheduling re-init');
      this.scheduleReinit();
    }
  }

  private scheduleReinit(): void {
    if (this.stopped) return;
    this.reinitTimer = setTimeout(() => void this.start(), this.config.retryDelayMs);
  }
}

export function countDeaths(msg: amqp.ConsumeMessage): number {
  const xDeath = msg.properties.headers?.['x-death'];
  if (!Array.isArray(xDeath)) return 0;
  return xDeath.reduce((sum, d) => sum + (typeof d?.count === 'number' ? d.count : 0), 0);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
