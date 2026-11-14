/**
 * S1 F2 — a provider error body that echoes the request (including the raw
 * payment-upload token minted for that attempt) must never reach a persisted
 * lastError, a log line, or an admin API response.
 *
 * Real NotificationSenderWorker, NotificationMessageBuilder, UploadLinkBinder,
 * PaymentUploadTokenService, QontakWhatsAppProvider and EmailNotificationProvider;
 * only Prisma, the payment-account source and the HTTP transports are stubbed.
 * Tokens are minted by the real service (random per run) and never printed.
 */
import { Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { NotificationSenderWorker } from '../../src/infrastructure/notifications/notification-sender.worker';
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder';
import { UploadLinkBinder } from '../../src/infrastructure/notifications/upload-link.binder';
import { PaymentUploadTokenService } from '../../src/modules/payments/payment-upload-token.service';
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import { EmailNotificationProvider } from '../../src/infrastructure/notifications/email-notification.provider';
import { TemplateRenderer } from '../../src/infrastructure/notifications/template-renderer';
import { QueueCenterService } from '../../src/infrastructure/lifecycle/queue-center.service';
import { NotificationCenterService } from '../../src/infrastructure/lifecycle/notification-center.service';
import { CustomerCommunicationService } from '../../src/modules/admin/customer-communication.service';
import { redactErrorText, scrubExactSecrets } from '../../src/common/logging/redact';

const ACCOUNT = { bankName: 'BCA', bankCode: '014', accountName: 'Toko', accountNumber: '1234567890' };
const SENDER_CONFIG = {
  enabled: true, batchSize: 50, leaseMs: 30_000, pollIntervalMs: 1_000, backoffBaseMs: 1_000, backoffCapMs: 100_000,
  maxAttempts: 8, healthLogIntervalMs: 60_000, breakerThreshold: 99, pauseMs: 30_000,
  emailApiKey: 'test-key', emailFrom: 'orders@masular.test', emailRequestTimeoutMs: 10_000,
};

function transferRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ntf-1', channel: NotificationChannel.WHATSAPP, recipient: '6281234567890', template: 'order.transfer',
    payload: { orderId: 'order-1', paymentId: 'pay-1', orderNumber: 'BMS-1', totalPrice: 135123, customerName: 'Jane', customerPhone: '6281234567890', customerEmail: 'jane@example.com', paymentMethod: 'QRIS' },
    status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0), lockedUntil: null, lockedBy: 'w#1',
    providerMessageId: null, lastError: null, sourceMessageId: 'evt-1', createdAt: new Date(0), sentAt: null,
    ...over,
  };
}

/** Capture every Nest Logger call (log/warn/error/debug/verbose) as one string per call. */
function captureLogs() {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

type HttpReply = { status: number; body: (requestBody: string, minted: string) => string };

function harness(channel: 'whatsapp' | 'email', reply: HttpReply) {
  const minted: string[] = [];
  const prisma = {
    notificationOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    paymentUploadToken: { create: jest.fn().mockResolvedValue({}) },
    payment: { findUnique: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
  };
  const tokens = new PaymentUploadTokenService(prisma as never);
  const realIssue = tokens.issue.bind(tokens);
  jest.spyOn(tokens, 'issue').mockImplementation(async (tx, paymentId) => {
    const issued = await realIssue(tx, paymentId);
    minted.push(issued.rawToken); // kept in memory for assertions only
    return issued;
  });
  const binder = new UploadLinkBinder(prisma as never, tokens);

  const registry = {
    resolve: jest.fn((ch: NotificationChannel) =>
      ch === NotificationChannel.WHATSAPP
        ? { providerTemplateId: 'tpl-invoice', body: [{ key: '1', valueName: 'customer_name', source: 'customerName' }], button: true }
        : { providerTemplateId: 'order.transfer' },
    ),
  };
  const builder = new NotificationMessageBuilder({ getActiveAccount: jest.fn().mockResolvedValue(ACCOUNT) } as never, registry as never);

  const http = jest.fn(async (_url: string, init: { body: string }) => ({
    status: reply.status,
    headers: { get: () => null },
    text: async () => reply.body(init.body, minted[minted.length - 1] ?? ''),
  }));
  let provider: QontakWhatsAppProvider | EmailNotificationProvider;
  if (channel === 'whatsapp') {
    provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 1000, maxRetry: 0 } as never,
      registry as never,
    );
  } else {
    // An EMAIL-channel transfer row: the token is bound for the attempt even though
    // the email template does not render it, so the email error path must scrub it too.
    provider = new EmailNotificationProvider(SENDER_CONFIG as never, new TemplateRenderer(), registry as never);
  }
  (provider as unknown as { http: unknown }).http = http;
  const factory = { get: jest.fn().mockReturnValue(provider) };
  const gate = { assertDeliverable: jest.fn() };
  const metrics = {
    claimed: jest.fn(), sent: jest.fn(), retried: jest.fn(), failedPermanent: jest.fn(),
    failedExhausted: jest.fn(), senderPaused: jest.fn(), senderResumed: jest.fn(), health: jest.fn(),
  };
  const worker = new NotificationSenderWorker(
    prisma as never, builder, factory as never, metrics as never, SENDER_CONFIG, gate as never, undefined, binder,
  );
  const persisted = () => prisma.notificationOutbox.updateMany.mock.calls.map((c) => (c[0] as { data: { lastError?: string } }).data.lastError ?? '');
  return { worker, minted, http, persisted, metrics };
}

// Echo the offending button value back, the way some providers do in validation errors.
const ECHO_BUTTON: HttpReply['body'] = (requestBody) => {
  const value = (JSON.parse(requestBody) as { parameters: { buttons: { value: string }[] } }).parameters.buttons[0].value;
  return `{"error":"invalid parameter","button":"${value}"}`;
};
// Echo the whole request with a short prefix, so the token STRADDLES the
// provider's 300-char truncation (would leave a partial token if truncation ran first).
const ECHO_REQUEST_STRADDLING: HttpReply['body'] = (requestBody) => `{"e":1,"r":${requestBody}}`;

describe('S1 F2: provider error text never persists or logs the bound upload token', () => {
  let logs: ReturnType<typeof captureLogs>;
  beforeEach(() => { logs = captureLogs(); });
  afterEach(() => logs.restore());

  it('WhatsApp 422 echoing the button value: lastError and logs keep the diagnostic but not the token', async () => {
    const h = harness('whatsapp', { status: 422, body: ECHO_BUTTON });
    await h.worker.sendRow(transferRow() as never);

    expect(h.minted).toHaveLength(1);
    const token = h.minted[0];
    // The request really carried the token in the button (so the echo contained it).
    expect(String(h.http.mock.calls[0][1].body)).toContain(token);

    const [lastError] = h.persisted();
    expect(lastError).toContain('qontak 422');
    expect(lastError).toContain('invalid parameter'); // useful diagnostic survives
    expect(lastError).toContain('[REDACTED]');
    expect(lastError).not.toContain(token);
    expect(h.metrics.failedPermanent).toHaveBeenCalled();
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.lines.join('\n')).not.toContain(token);
  });

  it('WhatsApp 503 echoing the button value (retry path): scheduled-retry lastError and logs are token-free', async () => {
    const h = harness('whatsapp', { status: 503, body: ECHO_BUTTON });
    await h.worker.sendRow(transferRow() as never);
    const token = h.minted[0];
    const [lastError] = h.persisted();
    expect(lastError).toContain('provider 503');
    expect(lastError).toContain('[REDACTED]');
    expect(lastError).not.toContain(token);
    expect(h.metrics.retried).toHaveBeenCalled();
    expect(logs.lines.join('\n')).not.toContain(token);
  });

  it('a token straddling the provider truncation point leaves no partial prefix behind', async () => {
    const h = harness('whatsapp', { status: 422, body: ECHO_REQUEST_STRADDLING });
    await h.worker.sendRow(transferRow() as never);
    const token = h.minted[0];
    const fullEcho = ECHO_REQUEST_STRADDLING(String(h.http.mock.calls[0][1].body), token);
    const start = fullEcho.indexOf(token);
    // Precondition: the raw token really straddles the 300-char cut.
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(300);
    expect(start + token.length).toBeGreaterThan(300);
    const prefix = token.slice(0, 16);
    expect(h.persisted()[0]).not.toContain(prefix);
    expect(logs.lines.join('\n')).not.toContain(prefix);
  });

  it('email provider error text containing the exact bound token is scrubbed before persistence and logging', async () => {
    const h = harness('email', { status: 422, body: (_req, minted) => JSON.stringify({ message: `rejected: link token ${minted} is not allowed` }) });
    await h.worker.sendRow(transferRow({ channel: NotificationChannel.EMAIL, recipient: 'jane@example.com' }) as never);
    const token = h.minted[0];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const [lastError] = h.persisted();
    expect(lastError).toContain('rejected: link token [REDACTED] is not allowed');
    expect(lastError).not.toContain(token);
    expect(logs.lines.join('\n')).not.toContain(token);
  });

  it('rows without an upload link are untouched by the scrub (diagnostics preserved verbatim)', async () => {
    const h = harness('whatsapp', { status: 422, body: () => '{"error":"template paused"}' });
    await h.worker.sendRow(transferRow({ template: 'order.cod', payload: { orderId: 'o', orderNumber: 'BMS-2', totalPrice: 1, customerPhone: '6281234567890' } }) as never);
    expect(h.minted).toHaveLength(0);
    expect(h.persisted()[0]).toBe('qontak 422: {"error":"template paused"}');
  });
});

describe('S1 F2: helpers', () => {
  it('scrubExactSecrets removes only the exact values and ignores empty/short ones', () => {
    const secret = 'ab'.repeat(32);
    expect(scrubExactSecrets(`x ${secret} y ${secret}`, [secret])).toBe('x [REDACTED] y [REDACTED]');
    expect(scrubExactSecrets('keep 1234', ['', undefined, null, '1234'])).toBe('keep 1234');
  });

  it('redactErrorText is null-safe and scrubs only upload-link token segments', () => {
    const secret = 'cd'.repeat(32);
    expect(redactErrorText(null)).toBeNull();
    expect(redactErrorText(undefined)).toBeNull();
    expect(redactErrorText(`provider 400: bad link https://shop.example/payment/${secret} (code 17)`)).toBe(
      'provider 400: bad link https://shop.example/payment/[REDACTED] (code 17)',
    );
    expect(redactErrorText('broker down')).toBe('broker down');
  });
});

describe('S1 F2: admin APIs never return an upload token held in a stored lastError', () => {
  const TOKEN = 'e1'.repeat(32);
  const LEGACY_ERROR = `qontak 422: invalid button https://shop.example/payment/${TOKEN}`;
  const NOW = new Date('2026-11-14T10:00:00Z');
  const OUTBOX_ROW = {
    id: 'evt-1', createdAt: NOW, eventName: 'order.created', eventVersion: 1, aggregateType: 'order', aggregateId: 'o1',
    exchange: 'orders', routingKey: 'order.created', status: 'FAILED', attempts: 10, maxAttempts: 10, nextAttemptAt: NOW,
    publishedAt: null, lastError: `relay failed for https://shop.example/payments/upload/${TOKEN}`, payload: { orderId: 'o1' },
    metadata: null, lockedUntil: null, lockedBy: null, occurredAt: NOW,
  };
  const NOTIF_ROW = {
    id: 'ntf-1', createdAt: NOW, channel: 'WHATSAPP', template: 'order.transfer', recipient: '628123', status: 'FAILED',
    attempts: 8, nextAttemptAt: NOW, sentAt: null, lastError: LEGACY_ERROR, providerMessageId: null, sourceMessageId: 'm',
    payload: { orderId: 'o1', orderNumber: 'BMS-1', customerEmail: 'jane@example.com' }, lockedUntil: null, lockedBy: null,
  };
  const leaks = (v: unknown) => JSON.stringify(v).includes(TOKEN);

  it('Queue Center: dead-letter summary and both lists', async () => {
    const prisma = {
      outboxEvent: { findMany: jest.fn().mockResolvedValue([OUTBOX_ROW]), count: jest.fn().mockResolvedValue(1) },
      notificationOutbox: { findMany: jest.fn().mockResolvedValue([NOTIF_ROW]), count: jest.fn().mockResolvedValue(1) },
    };
    const svc = new QueueCenterService(prisma as never, {} as never, { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never, undefined);
    const dead = await (svc as unknown as { deadLetters(now: Date): Promise<unknown> }).deadLetters(NOW);
    const outbox = await svc.listOutbox({});
    const notifications = await svc.listNotifications({});
    for (const res of [dead, outbox, notifications]) expect(leaks(res)).toBe(false);
    expect(outbox.items[0].lastError).toBe('relay failed for https://shop.example/payments/upload/[REDACTED]');
    expect(notifications.items[0].lastError).toBe('qontak 422: invalid button https://shop.example/payment/[REDACTED]');
  });

  it('Notification Center: overview failures, list and detail (row, providerResponse, retryHistory)', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      notificationOutbox: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([NOTIF_ROW]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue(NOTIF_ROW),
      },
    };
    const svc = new NotificationCenterService(prisma as never, {} as never, { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never);
    const overview = await svc.computeOverview();
    const list = await svc.list({});
    const detail = await svc.detail('ntf-1');
    for (const res of [overview, list, detail]) expect(leaks(res)).toBe(false);
    expect(detail.notification.lastError).toBe('qontak 422: invalid button https://shop.example/payment/[REDACTED]');
    expect(detail.providerResponse.lastError).toBe(detail.notification.lastError);
    expect(detail.retryHistory.lastError).toBe(detail.notification.lastError);
  });

  it('Customer Communication: conversation items', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', name: 'Jane', email: 'jane@example.com', phone: null }) },
      order: { groupBy: jest.fn().mockResolvedValue([]) },
      notificationOutbox: { findMany: jest.fn().mockResolvedValue([NOTIF_ROW]) },
    };
    const svc = new CustomerCommunicationService(prisma as never);
    const bundle = await svc.byCustomer('u1');
    expect(leaks(bundle)).toBe(false);
    expect(bundle.conversation[0].lastError).toBe('qontak 422: invalid button https://shop.example/payment/[REDACTED]');
  });
});
