import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationChannel, PaymentMethod, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { NotificationMetrics } from '../notifications/notification.metrics';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { CONSUMERS_CONFIG, ConsumersConfig } from './consumers.config';

// Topology (declared idempotently at startup):
//   orders --(order.created)--> order.created.notifications  (main)
//   main --nack(requeue=false)--> default exchange --> order.created.notifications.retry (TTL) --> back to main
//   poison / unrecoverable --> order.created.notifications.dlq (terminal, confirmed handoff)
const EXCHANGE = 'orders';
const ROUTING_KEY = 'order.created';
const QUEUE = 'order.created.notifications';
const RETRY_QUEUE = 'order.created.notifications.retry';
const DLQ = 'order.created.notifications.dlq';

/** NotificationOutbox.sourceMessageId is VarChar(36). */
const SOURCE_MESSAGE_ID_MAX = 36;
const OPS_SUFFIX = ':ops';

/**
 * Correlation id for the operator row: the customer row's id with an `:ops`
 * marker, trimmed to fit the column. A 36-char uuid messageId plus the suffix
 * would be 40 and the insert would throw, taking the whole transaction with it.
 */
export function opsSourceMessageId(messageId: string): string {
  return `${messageId.slice(0, SOURCE_MESSAGE_ID_MAX - OPS_SUFFIX.length)}${OPS_SUFFIX}`;
}
const CONSUMER = 'order.notifications';

type ProcessOutcome = 'enqueued' | 'duplicate' | 'skipped';

@Injectable()
export class OrderCreatedNotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OrderCreatedNotificationConsumer');
  private channel: amqp.ConfirmChannel | null = null;
  private consumerTag: string | null = null;
  private stopped = false;
  private paused = false;
  private reinitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    private readonly metrics: NotificationMetrics,
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
      this.channel = channel;
      await this.consume(channel);
      this.logger.log(`Consuming ${QUEUE}`);
    } catch (err) {
      this.logger.error(`Failed to start consumer: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReinit();
    }
  }

  private async consume(channel: amqp.ConfirmChannel): Promise<void> {
    const { consumerTag } = await channel.consume(
      QUEUE,
      (msg) => {
        if (msg) void this.handleDelivery(channel, msg);
      },
      { noAck: false },
    );
    this.consumerTag = consumerTag;
  }

  private async declareTopology(channel: amqp.ConfirmChannel): Promise<void> {
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

  async handleDelivery(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): Promise<void> {
    try {
      const messageId = msg.properties.messageId;
      if (!messageId) {
        await this.deadLetter(channel, msg, 'missing messageId');
        return;
      }

      let event: { name?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(msg.content.toString());
      } catch {
        await this.deadLetter(channel, msg, 'unparseable body');
        return;
      }

      try {
        const outcome = await this.process(messageId, event);
        channel.ack(msg);
        this.recordOutcome(outcome);
      } catch (err) {
        if (isUniqueViolation(err)) {
          channel.ack(msg);
          this.metrics.duplicate();
          return;
        }
        if (isInfraError(err)) {
          // F3: dependency down — requeue (no x-death increment) and pause; don't burn retries into the DLQ.
          await this.pauseForInfra(channel, msg);
          return;
        }
        const deaths = countDeaths(msg);
        if (deaths >= this.config.maxAttempts) {
          await this.deadLetter(channel, msg, err);
        } else {
          channel.nack(msg, false, false); // → retry queue (TTL) → back to main
          this.metrics.consumerRetried();
        }
      }
    } catch (dlErr) {
      // A confirmed DLQ handoff failed → leave the message unacked for redelivery (no loss).
      this.logger.error(`delivery handling failed (left unacked): ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
    }
  }

  /**
   * Which customer message (if any) an order-created event should produce.
   *
   *   BANK_TRANSFER / QRIS → `order.transfer`: bank details plus the
   *     upload-proof button. Requires the raw upload token checkout issued.
   *   COD                  → `order.cod`: nothing to pay up front.
   *   GATEWAY              → NONE. The customer is redirected to the hosted
   *     payment page at checkout, so there are no transfer instructions to send
   *     and no upload step to link to. Returning null skips the customer row
   *     deliberately, instead of enqueueing a message that cannot be built.
   *
   * A transfer-style method that somehow reaches here WITHOUT a token also
   * returns null: better a logged skip than a row that is guaranteed to fail
   * permanently in the builder.
   */
  private customerTemplateFor(
    method: PaymentMethod,
    uploadToken: string | null,
  ): 'order.transfer' | 'order.cod' | null {
    if (method === PaymentMethod.COD) return 'order.cod';
    if (method === PaymentMethod.GATEWAY) {
      this.logger.log(`order.created: GATEWAY order — no transfer instruction message (hosted payment page)`);
      return null;
    }
    if (!uploadToken) {
      this.logger.warn(`order.created: ${method} order has no upload token; skipping the customer invoice message`);
      return null;
    }
    return 'order.transfer';
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
      include: {
        user: { select: { email: true, name: true, phone: true } },
        address: { select: { phone: true } },
        // Payment state for the internal alert's "Pembayaran" line.
        payment: { select: { status: true } },
      },
    });
    if (!order || !order.user) {
      this.logger.warn(`order/recipient missing for order ${orderId}; skipping`);
      return 'skipped';
    }

    // WhatsApp recipient: prefer the delivery-address phone (always captured at
    // onboarding/checkout); fall back to User.phone (usually null for OAuth users).
    const phone = order.address?.phone ?? order.user.phone ?? null;

    // Channel = WHATSAPP; template chosen by payment method. The raw upload token is
    // the last path segment of the emitted uploadUrl — never the stored hash.
    //
    // 61AG.3.28: the selection used to be `isCod ? cod : transfer`, which sent
    // GATEWAY orders down the bank-transfer invoice. That template needs an
    // upload token, and checkout only issues one for BANK_TRANSFER/QRIS, so every
    // GATEWAY order died in the builder with "missing uploadToken" and was marked
    // permanently FAILED. GATEWAY has its own hosted payment page (checkout
    // returns paymentInstruction and the customer is redirected to
    // /payment/gateway/:paymentId), so a bank-transfer instruction message is not
    // merely unsendable there — it would be wrong.
    const uploadUrl = event.payload?.uploadUrl as string | undefined;
    const uploadToken = uploadUrl ? (uploadUrl.split('/').pop() ?? null) : null;
    const customerTemplate = this.customerTemplateFor(order.paymentMethod, uploadToken);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (customerTemplate) {
          await tx.notificationOutbox.create({
            data: {
              channel: NotificationChannel.WHATSAPP,
              recipient: phone ?? '',
              template: customerTemplate,
              payload: {
                orderId,
                orderNumber: event.payload?.orderNumber ?? order.orderNumber,
                totalPrice: event.payload?.totalPrice ?? order.totalPrice,
                customerName: order.user!.name,
                customerPhone: phone,
                customerEmail: order.user!.email,
                paymentMethod: order.paymentMethod,
                uploadToken,
              },
              sourceMessageId: messageId,
            },
          });
        }
        // PAXELBOX-37: the INTERNAL "new order arrived" alert, enqueued in the
        // same transaction so an operator alert can never exist without the
        // customer row that caused it (or vice versa).
        //
        // Deliberately a SECOND outbox row rather than an extra recipient on the
        // customer message: different template, different audience, and it must
        // be independently visible, retryable and gate-checked. It is skipped
        // silently when no operator number is configured, exactly as the admin
        // email events already skip on a missing ADMIN_NOTIFICATION_EMAIL.
        const opsPhone = this.config.opsNotificationWhatsapp;
        if (opsPhone) {
          await tx.notificationOutbox.create({
            data: {
              channel: NotificationChannel.WHATSAPP,
              recipient: opsPhone,
              template: 'order.new',
              payload: {
                orderId,
                orderNumber: order.orderNumber,
                customerName: order.user!.name,
                grandTotal: order.totalPrice,
                // Separate slots: the template renders "Metode Pembayaran" and
                // "Status Pembayaran" on their own lines.
                paymentMethod: order.paymentMethod,
                paymentStatus: order.payment?.status ?? 'PENDING',
                shippingMethod: [order.shippingProvider, order.shippingServiceName ?? order.shippingService]
                  .filter(Boolean)
                  .join(' · '),
                // Identifier only — the Qontak template supplies the base URL.
                adminOrderRef: orderId,
                // Marks the audience explicitly so this row can never be mistaken
                // for a customer message by anything reading the outbox.
                audience: 'internal',
              },
              // Distinct from the customer row's key so the two never collide,
              // and it MUST fit NotificationOutbox.sourceMessageId — VarChar(36).
              //
              // The relay sets messageId = OutboxEvent.id, a 36-char uuid, so the
              // old `${messageId}:ops` was 40 characters and the insert threw
              // "value too long", rolling back the WHOLE transaction — customer
              // invoice included. It never fired in practice only because the
              // operator number was unset, so this branch was dead; wiring
              // QONTAK_ADMIN in 61AG.3.28 would have activated it.
              //
              // Truncating is safe: this column carries no unique constraint and
              // is not the dedup key — exactly-once is enforced by ProcessedEvent
              // (consumer, messageId), which is written in this same transaction.
              sourceMessageId: opsSourceMessageId(messageId),
            },
          });
        }
        await tx.processedEvent.create({
          data: { consumer: CONSUMER, messageId, eventName: event.name ?? 'order.created' },
        });
      });
      return 'enqueued';
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err; // transient/infra → caller classifies
    }
  }

  private recordOutcome(outcome: ProcessOutcome): void {
    if (outcome === 'enqueued') this.metrics.enqueued();
    else if (outcome === 'duplicate') this.metrics.duplicate();
    else this.metrics.skipped('order_or_recipient_missing');
  }

  /** F2: publish to the DLQ on the confirm channel and await the broker ack BEFORE acking the original. */
  private async deadLetter(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage, reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason);
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        DLQ,
        msg.content,
        { ...msg.properties, headers: { ...(msg.properties.headers ?? {}), 'x-dead-letter-reason': message } },
        (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()),
      );
    });
    channel.ack(msg);
    this.metrics.deadLettered(message);
    this.logger.error(`Dead-lettered order.created delivery: ${message}`);
  }

  /** F3: requeue without dead-lettering (no x-death increment), stop consuming, resume after pauseMs. */
  private async pauseForInfra(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): Promise<void> {
    channel.nack(msg, false, true);
    if (this.paused) return;
    this.paused = true;
    this.metrics.consumerPaused();
    this.logger.warn('Dependency unavailable; pausing consumer');
    try {
      if (this.consumerTag) await channel.cancel(this.consumerTag);
    } catch {
      // best-effort
    }
    this.consumerTag = null;
    setTimeout(() => void this.resumeConsuming(channel), this.config.retryDelayMs).unref();
  }

  private async resumeConsuming(channel: amqp.ConfirmChannel): Promise<void> {
    if (this.stopped || !this.paused) return;
    try {
      await this.consume(channel);
      this.paused = false;
      this.metrics.consumerResumed();
      this.logger.log('Consumer resumed');
    } catch {
      setTimeout(() => void this.resumeConsuming(channel), this.config.retryDelayMs).unref();
    }
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
    if (this.stopped || this.reinitTimer) return; // single-flight
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      void this.start();
    }, this.config.retryDelayMs);
    this.reinitTimer.unref();
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

/** A dependency-unavailable error (DB connectivity), distinct from a poison message. */
export function isInfraError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientRustPanicError) return true;
  return err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017'].includes(err.code);
}
