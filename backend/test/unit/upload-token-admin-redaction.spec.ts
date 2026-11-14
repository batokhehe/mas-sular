/**
 * S1 containment: the payment-upload capability token must never leave the admin
 * read APIs (Queue Center lists, Notification Center detail/list, Customer
 * Communication), for any role that can reach them. The stored rows still hold
 * the token (the sender needs it), so these tests also prove the redaction works
 * on COPIES and never mutates what the delivery path reads.
 */
import { randomBytes } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { QueueCenterService } from '../../src/infrastructure/lifecycle/queue-center.service';
import { NotificationCenterService } from '../../src/infrastructure/lifecycle/notification-center.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import {
  CAPABILITY_SECRET_KEYS,
  collectCapabilitySecrets,
  redactCapabilitySecrets,
  redactRenderedText,
  redactUploadLinks,
} from '../../src/common/logging/redact';
import { sanitizeSnapshot } from '../../src/infrastructure/audit/audit-diff.util';
import { ALL_PERMISSION_NAMES, ROLE_PERMISSION_MATRIX, SYSTEM_ROLES } from '../../prisma/bootstrap/permission-catalogue';

// Synthetic secrets, regenerated per run; never a real token.
const TOKEN = randomBytes(32).toString('hex');
const UPLOAD_URL = `https://shop.example/payment/${TOKEN}`;
const LEGACY_URL = `https://shop.example/api/v1/payments/upload/${TOKEN}`;
const CREATED = new Date('2026-11-13T10:00:00Z');

// structuredClone keeps Date fields as Dates (the services call toISOString on them).
const deepClone = <T>(v: T): T => structuredClone(v);
const leaks = (v: unknown): boolean => JSON.stringify(v).includes(TOKEN);

const OUTBOX_ROW = {
  id: 'evt-1', createdAt: CREATED, eventName: 'order.created', eventVersion: 1,
  aggregateType: 'order', aggregateId: 'o1', exchange: 'orders', routingKey: 'order.created',
  status: 'PUBLISHED', attempts: 1, maxAttempts: 10, nextAttemptAt: CREATED, publishedAt: CREATED,
  lastError: null, lockedUntil: null, lockedBy: null, occurredAt: CREATED,
  payload: { orderId: 'o1', orderNumber: 'BMS-1', totalPrice: 135123, uploadUrl: UPLOAD_URL },
  metadata: { source: 'orders.checkout' },
};
const REMINDER_EVENT_ROW = {
  ...OUTBOX_ROW, id: 'evt-2', eventName: 'payment.reminder', aggregateType: 'payment', aggregateId: 'pay-1',
  payload: { paymentId: 'pay-1', orderId: 'o1', stage: 'first', paymentMethod: 'BANK_TRANSFER', amount: 135123, uploadUrl: UPLOAD_URL },
};
const WA_ROW = {
  id: 'ntf-wa', createdAt: CREATED, channel: 'WHATSAPP', template: 'order.transfer', recipient: '628123',
  status: 'SENT', attempts: 1, nextAttemptAt: CREATED, sentAt: CREATED, lastError: null,
  providerMessageId: 'q-1', sourceMessageId: 'msg-1', lockedUntil: null, lockedBy: null,
  payload: { orderId: 'o1', orderNumber: 'BMS-1', totalPrice: 135123, customerName: 'Jane', uploadToken: TOKEN },
};
const EMAIL_REMINDER_ROW = {
  ...WA_ROW, id: 'ntf-mail', channel: 'EMAIL', template: 'payment.reminder', recipient: 'jane@example.com',
  payload: { orderId: 'o1', orderNumber: 'BMS-1', customerName: 'Jane', amount: 135123, paymentMethod: 'BANK_TRANSFER', stage: 'first', uploadUrl: UPLOAD_URL },
};

function queueCenter(outboxRows: unknown[], notificationRows: unknown[]) {
  const prisma = {
    outboxEvent: { findMany: jest.fn().mockResolvedValue(outboxRows), count: jest.fn().mockResolvedValue(outboxRows.length) },
    notificationOutbox: { findMany: jest.fn().mockResolvedValue(notificationRows), count: jest.fn().mockResolvedValue(notificationRows.length) },
  };
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new QueueCenterService(prisma as any, {} as any, cache as any, undefined);
}

function notificationCenter(row: unknown, rows: unknown[] = [row]) {
  const prisma = {
    notificationOutbox: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(rows.length),
    },
  };
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NotificationCenterService(prisma as any, {} as any, cache as any);
}

function permissionsOf(role: (typeof SYSTEM_ROLES)[number]): readonly string[] {
  return role === 'SUPER_ADMIN' ? ALL_PERMISSION_NAMES : ROLE_PERMISSION_MATRIX[role];
}

function guardAllows(permission: string, permissions: readonly string[]): boolean {
  const reflector = { getAllAndOverride: () => [permission] };
  const guard = new PermissionGuard(reflector as never);
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ user: { permissions: [...permissions] } }) }), getHandler: () => null, getClass: () => null } as never;
  try {
    return guard.canActivate(ctx) === true;
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

describe('S1 redaction helpers', () => {
  it('covers exactly the payment-upload capability keys', () => {
    expect([...CAPABILITY_SECRET_KEYS].sort()).toEqual(['uploadToken', 'uploadUrl']);
  });

  it('redacts the keys at any depth, including inside arrays, and keeps every other field', () => {
    const input = {
      orderId: 'o1',
      uploadToken: TOKEN,
      nested: { uploadUrl: UPLOAD_URL, keep: 'x', deeper: [{ uploadToken: TOKEN, n: 1 }, { other: LEGACY_URL }] },
      list: [UPLOAD_URL, 'plain'],
      n: 5, flag: true, nothing: null,
    };
    const out = redactCapabilitySecrets(input);
    expect(leaks(out)).toBe(false);
    expect(out).toEqual({
      orderId: 'o1',
      uploadToken: '[REDACTED]',
      nested: { uploadUrl: '[REDACTED]', keep: 'x', deeper: [{ uploadToken: '[REDACTED]', n: 1 }, { other: 'https://shop.example/api/v1/payments/upload/[REDACTED]' }] },
      list: ['https://shop.example/payment/[REDACTED]', 'plain'],
      n: 5, flag: true, nothing: null,
    });
  });

  it('never mutates its input (the stored row the sender reads)', () => {
    const input = { uploadToken: TOKEN, nested: { uploadUrl: UPLOAD_URL } };
    const before = deepClone(input);
    redactCapabilitySecrets(input);
    expect(input).toEqual(before);
  });

  it('keeps null/undefined capability keys as they are and passes non-objects through', () => {
    expect(redactCapabilitySecrets({ uploadUrl: null, uploadToken: undefined })).toEqual({ uploadUrl: null, uploadToken: undefined });
    expect(redactCapabilitySecrets(null)).toBeNull();
    expect(redactCapabilitySecrets(42)).toBe(42);
  });

  it('scrubs upload-link token segments in free text, but not other storefront routes', () => {
    expect(redactUploadLinks(`go to ${UPLOAD_URL} now`)).toBe('go to https://shop.example/payment/[REDACTED] now');
    expect(redactUploadLinks(LEGACY_URL)).toBe('https://shop.example/api/v1/payments/upload/[REDACTED]');
    expect(redactUploadLinks('https://shop.example/payment/gateway/pay-1')).toBe('https://shop.example/payment/gateway/pay-1');
    expect(redactUploadLinks('https://shop.example/payment/success')).toBe('https://shop.example/payment/success');
  });

  it('rendered text is scrubbed by exact payload value too, whatever the link shape', () => {
    const odd = `https://other.example/x?t=${TOKEN}`;
    const payload = { uploadUrl: odd };
    expect(collectCapabilitySecrets(payload)).toContain(odd);
    expect(redactRenderedText(`Upload here: ${odd}`, payload)).toBe('Upload here: [REDACTED]');
    expect(redactRenderedText(`token ${TOKEN}`, { uploadToken: TOKEN })).toBe('token [REDACTED]');
  });
});

describe('S1: audit snapshots drop the upload capability keys', () => {
  it('sanitizeSnapshot strips uploadToken and uploadUrl, keeps the rest', () => {
    const snap = sanitizeSnapshot({ orderId: 'o1', uploadToken: TOKEN, uploadUrl: UPLOAD_URL }) as Record<string, unknown>;
    expect(leaks(snap)).toBe(false);
    expect(snap).toEqual({ orderId: 'o1' });
  });
});

describe('S1: Queue Center lists never return the upload token', () => {
  it('outbox list: order.created and payment.reminder payloads are redacted; refs and other fields survive', async () => {
    const rows = [deepClone(OUTBOX_ROW), deepClone(REMINDER_EVENT_ROW)];
    const stored = deepClone(rows);
    const res = await queueCenter(rows, []).listOutbox({ page: 1, limit: 10 });
    expect(leaks(res)).toBe(false);
    expect(res.items[0].payload).toEqual({ orderId: 'o1', orderNumber: 'BMS-1', totalPrice: 135123, uploadUrl: '[REDACTED]' });
    expect(res.items[1].payload).toMatchObject({ paymentId: 'pay-1', stage: 'first', uploadUrl: '[REDACTED]' });
    expect(res.items[0].related).toMatchObject({ orderId: 'o1', orderNumber: 'BMS-1' });
    expect(res.items[0].metadata).toEqual({ source: 'orders.checkout' });
    expect(rows).toEqual(stored); // DB rows (as returned by Prisma) untouched
  });

  it('notification list: WhatsApp uploadToken and email uploadUrl are redacted', async () => {
    const rows = [deepClone(WA_ROW), deepClone(EMAIL_REMINDER_ROW)];
    const stored = deepClone(rows);
    const res = await queueCenter([], rows).listNotifications({ page: 1, limit: 10 });
    expect(leaks(res)).toBe(false);
    expect(res.items[0].payload).toMatchObject({ orderNumber: 'BMS-1', uploadToken: '[REDACTED]' });
    expect(res.items[1].payload).toMatchObject({ stage: 'first', uploadUrl: '[REDACTED]' });
    expect(rows).toEqual(stored);
  });

  it('a nested capability key in a future payload shape is redacted too', async () => {
    const row = { ...deepClone(OUTBOX_ROW), payload: { orderId: 'o1', links: { customer: { uploadUrl: UPLOAD_URL } } } };
    const res = await queueCenter([row], []).listOutbox({});
    expect(leaks(res)).toBe(false);
    expect(res.items[0].payload).toEqual({ orderId: 'o1', links: { customer: { uploadUrl: '[REDACTED]' } } });
  });
});

describe('S1: Notification Center never returns the upload token', () => {
  it('detail of a WhatsApp transfer row: payload redacted, rest of the row intact', async () => {
    const row = deepClone(WA_ROW);
    const d = await notificationCenter(row).detail('ntf-wa');
    expect(leaks(d)).toBe(false);
    expect(d.notification.payload).toMatchObject({ orderNumber: 'BMS-1', uploadToken: '[REDACTED]' });
    expect(d.notification).toMatchObject({ id: 'ntf-wa', template: 'order.transfer', recipient: '628123', status: 'SENT' });
    expect(row.payload.uploadToken).toBe(TOKEN); // stored row untouched
  });

  it('detail of an email reminder: rendered body keeps its text but the whole upload link is redacted', async () => {
    const row = deepClone(EMAIL_REMINDER_ROW);
    const d = await notificationCenter(row).detail('ntf-mail');
    expect(leaks(d)).toBe(false);
    expect(d.rendered?.subject).toContain('BMS-1');
    expect(d.rendered?.body).toContain('a friendly reminder to complete payment for order BMS-1');
    expect(d.rendered?.body).toContain('Upload your receipt here: [REDACTED]');
    expect(d.rendered?.body).not.toContain('shop.example');
    expect(d.notification.payload).toMatchObject({ uploadUrl: '[REDACTED]' });
    expect(row.payload.uploadUrl).toBe(UPLOAD_URL);
  });

  it('detail of an order.received email (legacy link shape) is scrubbed as well', async () => {
    const row = { ...deepClone(EMAIL_REMINDER_ROW), template: 'order.received', payload: { orderNumber: 'BMS-1', customerName: 'Jane', totalPrice: 1, uploadUrl: LEGACY_URL } };
    const d = await notificationCenter(row).detail('ntf-mail');
    expect(leaks(d)).toBe(false);
    expect(d.rendered?.body).toContain('[REDACTED]');
  });

  it('list rows carry no payload and a token-free subject', async () => {
    const rows = [deepClone(WA_ROW), deepClone(EMAIL_REMINDER_ROW)];
    const res = await notificationCenter(rows[0], rows).list({ page: 1, limit: 10 });
    expect(leaks(res)).toBe(false);
  });
});

describe('S1: every role that can reach these APIs gets redacted output (permissions unchanged)', () => {
  const readers = (permission: string) => SYSTEM_ROLES.filter((r) => guardAllows(permission, permissionsOf(r)));

  it('Notification.read: SUPER_ADMIN, ADMIN, MANAGER and STAFF pass the guard, CUSTOMER does not', () => {
    expect(readers('Notification.read')).toEqual(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']);
  });

  it('Queue.read: SUPER_ADMIN and ADMIN pass the guard, the others do not', () => {
    expect(readers('Queue.read')).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });

  it.each(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as const)('%s: Notification Center detail returns no token or upload URL', async (role) => {
    expect(guardAllows('Notification.read', permissionsOf(role))).toBe(true);
    for (const row of [WA_ROW, EMAIL_REMINDER_ROW]) {
      const d = await notificationCenter(deepClone(row)).detail(row.id);
      expect(leaks(d)).toBe(false);
    }
  });

  it.each(['SUPER_ADMIN', 'ADMIN'] as const)('%s: Queue Center lists return no token or upload URL', async (role) => {
    expect(guardAllows('Queue.read', permissionsOf(role))).toBe(true);
    const svc = queueCenter([deepClone(OUTBOX_ROW), deepClone(REMINDER_EVENT_ROW)], [deepClone(WA_ROW), deepClone(EMAIL_REMINDER_ROW)]);
    expect(leaks(await svc.listOutbox({}))).toBe(false);
    expect(leaks(await svc.listNotifications({}))).toBe(false);
  });
});
