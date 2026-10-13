import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { NotificationChannel, NotificationOutbox } from '@prisma/client';
import { AdminInvoiceLinkService, invoiceWhatsAppMessage } from '../../src/modules/admin/admin-invoice-link.service';
import { CustomerCommunicationService } from '../../src/modules/admin/customer-communication.service';
import { AdminOperationsController } from '../../src/modules/admin/presentation/admin-operations.controller';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder';
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';
import { mapAuditRoute } from '../../src/infrastructure/audit/audit-route.map';
import { sanitizeSnapshot } from '../../src/infrastructure/audit/audit-diff.util';

/**
 * P2 #14 — Admin Order Detail: create / send the customer invoice link.
 *
 * WhatsApp goes through the REAL Customer Communication Center send (outbox row),
 * the REAL message builder and the REAL Qontak provider; only the provider's HTTP
 * transport is stubbed, and a global fetch spy proves no network call is made.
 */

const RAW = 'b'.repeat(64);
const URL_ = `https://shop.example/invoice/${RAW}`;
const ADMIN = { id: 'admin-1', name: 'Super Admin' };
const ORDER = {
  id: 'order-A',
  orderNumber: 'BMS-20260911-ABCD',
  userId: 'user-1',
  address: { recipientName: 'Budi', phone: '081234567890' },
  user: { name: 'Budi S', phone: null },
};

function tokens(over: Record<string, jest.Mock> = {}) {
  return {
    issue: jest.fn().mockResolvedValue({ id: 'tok-new', rawToken: RAW, invoiceUrl: URL_, expiresAt: new Date('2026-10-11T03:00:00Z'), createdAt: new Date('2026-09-11T03:00:00Z') }),
    revokeOthers: jest.fn().mockResolvedValue(1),
    discard: jest.fn().mockResolvedValue(undefined),
    activeLink: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

function build(opts: { order?: unknown; manualTemplate?: string | null } = {}) {
  if (opts.manualTemplate === null) delete process.env.QONTAK_MANUAL_TEMPLATE_ID;
  else process.env.QONTAK_MANUAL_TEMPLATE_ID = opts.manualTemplate ?? 'tpl-manual';
  const outboxCreate = jest.fn().mockImplementation(({ data }) =>
    Promise.resolve({ id: 'notif-1', status: 'PENDING', createdAt: new Date('2026-09-11T03:00:01Z'), ...data }),
  );
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(opts.order === undefined ? ORDER : opts.order) },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', name: 'Budi S', email: 'budi@example.test', phone: null }) },
    notificationOutbox: { create: outboxCreate },
  };
  const t = tokens();
  const communication = new CustomerCommunicationService(prisma as never);
  const svc = new AdminInvoiceLinkService(prisma as never, t as never, communication);
  return { svc, prisma, t, outboxCreate };
}

describe('AdminInvoiceLinkService', () => {
  it('17/18. create: issues a new link, then revokes the order\'s older links; the link is returned once', async () => {
    const { svc, t } = build();
    const res = await svc.create('order-A', ADMIN);
    expect(t.issue).toHaveBeenCalledWith('order-A', 'admin-1');
    expect(t.revokeOthers).toHaveBeenCalledWith('order-A', 'tok-new');
    expect(res).toEqual({ invoiceUrl: URL_, createdAt: '2026-09-11T03:00:00.000Z', expiresAt: '2026-10-11T03:00:00.000Z' });
  });

  it('status returns dates only - never a link or a hash', async () => {
    const { svc, t } = build();
    t.activeLink.mockResolvedValue({ createdAt: new Date('2026-09-11T03:00:00Z'), expiresAt: new Date('2026-10-11T03:00:00Z') });
    const res = await svc.status('order-A');
    expect(res).toEqual({ active: { createdAt: '2026-09-11T03:00:00.000Z', expiresAt: '2026-10-11T03:00:00.000Z' } });
    expect(JSON.stringify(res)).not.toMatch(/invoice\/|tokenHash|[0-9a-f]{64}/);
  });

  it('unknown or deleted orders are a 404 before anything is issued', async () => {
    const { svc, t, prisma } = build({ order: null });
    await expect(svc.create('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.sendWhatsApp('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'nope', deletedAt: null });
    expect(t.issue).not.toHaveBeenCalled();
  });

  it('19/23. WhatsApp: queues ONE outbox row through the existing manual-send path, carrying the invoice URL', async () => {
    const { svc, t, outboxCreate } = build();
    const res = await svc.sendWhatsApp('order-A', ADMIN);

    expect(outboxCreate).toHaveBeenCalledTimes(1);
    const row = outboxCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ channel: NotificationChannel.WHATSAPP, template: 'manual.order-update', recipient: '6281234567890' });
    expect(row.payload).toMatchObject({ orderId: 'order-A', orderNumber: 'BMS-20260911-ABCD', customerName: 'Budi', source: 'manual', sentById: 'admin-1' });
    expect(row.payload.message).toContain(URL_);
    expect(row.payload.message).toContain('BMS-20260911-ABCD');
    // Older links are revoked only after the message was accepted.
    expect(t.revokeOthers).toHaveBeenCalledWith('order-A', 'tok-new');
    expect(t.discard).not.toHaveBeenCalled();
    // Success = accepted into the queue (PENDING), never "delivered".
    expect(res.notification).toEqual({ id: 'notif-1', status: 'PENDING', createdAt: '2026-09-11T03:00:01.000Z' });
    expect(res.invoiceUrl).toBe(URL_);
  });

  it('20. a refused send surfaces as a failure, throws the unsent link away and keeps the customer\'s current link', async () => {
    const { svc, t, outboxCreate } = build({ manualTemplate: null });
    await expect(svc.sendWhatsApp('order-A', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sendWhatsApp('order-A', ADMIN)).rejects.toThrow(/not configured/);
    expect(outboxCreate).not.toHaveBeenCalled();
    expect(t.discard).toHaveBeenCalledWith('tok-new');
    expect(t.revokeOthers).not.toHaveBeenCalled();
  });

  it('an order without any WhatsApp number is refused before a link is issued', async () => {
    const { svc, t } = build({ order: { ...ORDER, address: { recipientName: 'Budi', phone: '' }, user: { name: 'Budi', phone: null } } });
    await expect(svc.sendWhatsApp('order-A', ADMIN)).rejects.toThrow(/no WhatsApp number/);
    expect(t.issue).not.toHaveBeenCalled();
  });

  it('the message is customer-friendly and says what the link is for', () => {
    const msg = invoiceWhatsAppMessage({ customerName: 'Budi', orderNumber: 'BMS-1', invoiceUrl: URL_, expiresAt: new Date('2026-10-11T03:00:00Z') });
    expect(msg).toBe(`Halo Budi, berikut invoice untuk pesanan BMS-1 di Bakso Mas Sular:\n${URL_}\nLink ini bisa dibuka dan dicetak sampai 11 Oktober 2026. Terima kasih!`);
  });
});

describe('Qontak delivery of the queued invoice message (stubbed transport)', () => {
  it('22/23/24. the real builder + provider send the URL in the approved manual template - and no real request is made', async () => {
    const { svc, outboxCreate } = build({ manualTemplate: 'tpl-manual' });
    await svc.sendWhatsApp('order-A', ADMIN);
    const row = { id: 'notif-1', ...outboxCreate.mock.calls[0][0].data } as unknown as NotificationOutbox;

    const registry = new TemplateRegistry(); // reads QONTAK_MANUAL_TEMPLATE_ID
    const builder = new NotificationMessageBuilder({ getActiveAccount: jest.fn() } as never, registry);
    const message = await builder.build(row);

    const provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 'tok', channelIntegrationId: 'ci', timeoutMs: 1000, maxRetry: 0 },
      registry,
    );
    const http = jest.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ data: { id: 'q-1' } }), headers: { get: () => null } });
    (provider as unknown as { http: unknown }).http = http;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const logs = [jest.spyOn(Logger.prototype, 'log'), jest.spyOn(Logger.prototype, 'warn'), jest.spyOn(Logger.prototype, 'error')];

    const res = await provider.send(message);

    expect(res.providerMessageId).toBe('q-1');
    expect(fetchSpy).not.toHaveBeenCalled(); // 24: the stub is the only transport
    expect(http).toHaveBeenCalledTimes(1);
    const body = JSON.parse(http.mock.calls[0][1].body);
    expect(body).toMatchObject({ to_number: '6281234567890', message_template_id: 'tpl-manual' });
    expect(body.parameters.body).toEqual([expect.objectContaining({ key: '1', value_text: expect.stringContaining(URL_) })]);
    // The provider never logs the message text (so the link never reaches logs).
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(RAW);

    fetchSpy.mockRestore();
    logs.forEach((s) => s.mockRestore());
  });
});

describe('Admin endpoints: permissions and audit', () => {
  const perms = (method: keyof AdminOperationsController) => Reflect.getMetadata(PERMISSIONS_KEY, AdminOperationsController.prototype[method]);

  it('reading needs Order.read, creating Order.update, sending also Notification.send', () => {
    expect(perms('invoiceLinkStatus')).toEqual(['Order.read']);
    expect(perms('createInvoiceLink')).toEqual(['Order.update']);
    expect(perms('sendInvoiceLinkWhatsApp')).toEqual(['Order.update', 'Notification.send']);
  });

  it('both actions are audited under their own entity, and the audit snapshot drops the link', () => {
    expect(mapAuditRoute('POST', '/api/v1/admin/orders/order-A/invoice-link')).toEqual({ module: 'orders', entity: 'OrderInvoiceLink', action: 'CREATE' });
    expect(mapAuditRoute('POST', '/api/v1/admin/orders/order-A/invoice-link/whatsapp')).toEqual({ module: 'orders', entity: 'OrderInvoiceLink', action: 'SEND_MANUAL_NOTIFICATION' });
    expect(mapAuditRoute('GET', '/api/v1/admin/orders/order-A/invoice-link')).toBeNull();
    const snapshot = sanitizeSnapshot({ invoiceUrl: URL_, expiresAt: '2026-10-11', notification: { id: 'n1', status: 'PENDING' } });
    expect(JSON.stringify(snapshot)).not.toContain(RAW);
    expect(snapshot).toEqual({ expiresAt: '2026-10-11', notification: { id: 'n1', status: 'PENDING' } });
  });
});
