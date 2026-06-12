import { Prisma } from '@prisma/client';
import {
  OrderCreatedNotificationConsumer,
  countDeaths,
} from '../../src/infrastructure/consumers/order-created-notification.consumer';
import { ConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';

const CONFIG: ConsumersConfig = {
  enabled: true,
  rabbitmqUrl: 'amqp://localhost',
  prefetch: 10,
  maxAttempts: 5,
  retryDelayMs: 30_000,
};

const ORDER = { id: 'order-1', user: { email: 'jane@example.com', name: 'Jane' } };
const EVENT = { name: 'order.created', payload: { orderId: 'order-1', orderNumber: 'BN-1', totalPrice: 30000 } };

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3' });
}

function buildPrisma(over: { seen?: unknown; order?: unknown; txFail?: Error } = {}) {
  const tx = { notificationOutbox: { create: jest.fn().mockResolvedValue({}) }, processedEvent: { create: jest.fn() } };
  tx.processedEvent.create.mockImplementation(() => (over.txFail ? Promise.reject(over.txFail) : Promise.resolve({})));
  const prisma = {
    processedEvent: { findUnique: jest.fn().mockResolvedValue(over.seen ?? null) },
    order: { findUnique: jest.fn().mockResolvedValue('order' in over ? over.order : ORDER) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
  return prisma;
}

function build(prisma = buildPrisma(), config = CONFIG) {
  const rabbit = { createConsumerChannel: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consumer = new OrderCreatedNotificationConsumer(prisma as any, rabbit as any, config);
  return { consumer, prisma, rabbit };
}

function msg(props: Record<string, unknown> = {}, content = JSON.stringify(EVENT)) {
  return {
    content: Buffer.from(content),
    properties: { messageId: 'evt-1', headers: {}, ...props },
  } as any;
}

function fakeChannel() {
  return { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn() };
}

describe('OrderCreatedNotificationConsumer', () => {
  describe('process — dedup + enqueue', () => {
    it('enqueues a notification and records ProcessedEvent in one transaction', async () => {
      const { consumer, prisma } = build();

      const outcome = await consumer.process('evt-1', EVENT);

      expect(outcome).toBe('enqueued');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channel: 'EMAIL',
          recipient: 'jane@example.com',
          template: 'order.received',
          sourceMessageId: 'evt-1',
          payload: expect.objectContaining({ orderId: 'order-1', orderNumber: 'BN-1', totalPrice: 30000, customerName: 'Jane' }),
        }),
      });
      expect(prisma.__tx.processedEvent.create).toHaveBeenCalledWith({
        data: { consumer: 'order.notifications', messageId: 'evt-1', eventName: 'order.created' },
      });
    });

    it('fast-path duplicate: ProcessedEvent already exists → no work', async () => {
      const { consumer, prisma } = build(buildPrisma({ seen: { messageId: 'evt-1' } }));

      const outcome = await consumer.process('evt-1', EVENT);

      expect(outcome).toBe('duplicate');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('race duplicate: ProcessedEvent insert hits P2002 → duplicate (rolled back)', async () => {
      const { consumer } = build(buildPrisma({ txFail: uniqueViolation() }));
      expect(await consumer.process('evt-1', EVENT)).toBe('duplicate');
    });

    it('skips when payload has no orderId', async () => {
      const { consumer, prisma } = build();
      expect(await consumer.process('evt-1', { name: 'order.created', payload: {} })).toBe('skipped');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('skips when the order or recipient is gone', async () => {
      const { consumer } = build(buildPrisma({ order: null }));
      expect(await consumer.process('evt-1', EVENT)).toBe('skipped');
    });

    it('rethrows a transient (non-unique) error for retry', async () => {
      const { consumer } = build(buildPrisma({ txFail: new Error('deadlock') }));
      await expect(consumer.process('evt-1', EVENT)).rejects.toThrow('deadlock');
    });
  });

  describe('handleDelivery — ack/nack routing', () => {
    it('acks on success', async () => {
      const { consumer } = build();
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg());
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(ch.nack).not.toHaveBeenCalled();
    });

    it('dead-letters a message with no messageId', async () => {
      const { consumer } = build();
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ messageId: undefined }));
      expect(ch.sendToQueue).toHaveBeenCalledWith('order.created.notifications.dlq', expect.any(Buffer), expect.anything());
      expect(ch.ack).toHaveBeenCalledTimes(1);
    });

    it('dead-letters an unparseable body', async () => {
      const { consumer } = build();
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({}, 'not-json{'));
      expect(ch.sendToQueue).toHaveBeenCalledWith('order.created.notifications.dlq', expect.any(Buffer), expect.anything());
      expect(ch.ack).toHaveBeenCalledTimes(1);
    });

    it('nacks (→ retry) on a transient error below the death cap', async () => {
      const { consumer } = build(buildPrisma({ txFail: new Error('deadlock') }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ headers: { 'x-death': [{ count: 2 }] } }));
      expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, false);
      expect(ch.ack).not.toHaveBeenCalled();
    });

    it('dead-letters a poison message at/above the death cap', async () => {
      const { consumer } = build(buildPrisma({ txFail: new Error('deadlock') }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ headers: { 'x-death': [{ count: 5 }] } }));
      expect(ch.sendToQueue).toHaveBeenCalledWith('order.created.notifications.dlq', expect.any(Buffer), expect.anything());
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(ch.nack).not.toHaveBeenCalled();
    });

    it('acks a duplicate without retry', async () => {
      const { consumer } = build(buildPrisma({ seen: { messageId: 'evt-1' } }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg());
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(ch.nack).not.toHaveBeenCalled();
    });
  });

  describe('topology + lifecycle', () => {
    it('declares exchange, retry queue, DLQ, main queue and binding', async () => {
      const channel = {
        assertExchange: jest.fn().mockResolvedValue({}),
        assertQueue: jest.fn().mockResolvedValue({}),
        bindQueue: jest.fn().mockResolvedValue({}),
        prefetch: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
        on: jest.fn(),
      };
      const rabbit = { createConsumerChannel: jest.fn().mockResolvedValue(channel) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const consumer = new OrderCreatedNotificationConsumer(buildPrisma() as any, rabbit as any, CONFIG);

      await consumer.onApplicationBootstrap();

      expect(channel.assertExchange).toHaveBeenCalledWith('orders', 'topic', { durable: true });
      expect(channel.assertQueue).toHaveBeenCalledWith('order.created.notifications.dlq', { durable: true });
      expect(channel.assertQueue).toHaveBeenCalledWith(
        'order.created.notifications.retry',
        expect.objectContaining({ arguments: expect.objectContaining({ 'x-message-ttl': 30000, 'x-dead-letter-routing-key': 'order.created.notifications' }) }),
      );
      expect(channel.assertQueue).toHaveBeenCalledWith(
        'order.created.notifications',
        expect.objectContaining({ arguments: expect.objectContaining({ 'x-dead-letter-routing-key': 'order.created.notifications.retry' }) }),
      );
      expect(channel.bindQueue).toHaveBeenCalledWith('order.created.notifications', 'orders', 'order.created');
      expect(channel.consume).toHaveBeenCalledTimes(1);
    });

    it('does not start when disabled', async () => {
      const { consumer, rabbit } = build(buildPrisma(), { ...CONFIG, enabled: false });
      await consumer.onApplicationBootstrap();
      expect(rabbit.createConsumerChannel).not.toHaveBeenCalled();
    });

    it('stays idle when enabled without a broker URL', async () => {
      const { consumer, rabbit } = build(buildPrisma(), { ...CONFIG, rabbitmqUrl: undefined });
      await consumer.onApplicationBootstrap();
      expect(rabbit.createConsumerChannel).not.toHaveBeenCalled();
    });
  });

  describe('countDeaths', () => {
    it('sums x-death counts; 0 when absent', () => {
      expect(countDeaths(msg({ headers: {} }))).toBe(0);
      expect(countDeaths(msg({ headers: { 'x-death': [{ count: 2 }, { count: 3 }] } }))).toBe(5);
    });
  });
});
