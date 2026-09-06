/**
 * PAXELBOX-61AG.3.28 — the complete WhatsApp order lifecycle (WA-001..024).
 *
 * Runs the REAL pipeline for everything after the outbox row: the real
 * OrderCreatedNotificationConsumer, the real TemplateRegistry, the real
 * NotificationMessageBuilder and the real QontakWhatsAppProvider. Only the two
 * edges are substituted — Prisma and the Qontak HTTP transport — so what is
 * asserted is the payload Qontak would actually have received.
 *
 * No real Qontak call, no database, no courier, no payment provider.
 */
import { NotificationChannel, NotificationOutbox } from '@prisma/client';
import { OrderCreatedNotificationConsumer } from '../../src/infrastructure/consumers/order-created-notification.consumer';
import { loadConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';
import { opsSourceMessageId } from '../../src/infrastructure/consumers/order-created-notification.consumer';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder';
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import {
  NotificationDeliveryGate,
  NotificationBlockedError,
  loadNotificationDeliveryConfig,
} from '../../src/infrastructure/notifications/notification-delivery.gate';
import { TransientSendError } from '../../src/infrastructure/notifications/notification-provider';

// ---------------------------------------------------------------- fixtures --

const ORDER_ID = 'ord-uuid-1';
const ORDER_NO = 'BMS-20260904-XYZ';
const CUSTOMER_PHONE = '628123456789';
const ADMIN_PHONE = '628990000111';
const UPLOAD_TOKEN = 'a'.repeat(64); // 256-bit hex, as PaymentUploadTokenService issues

const TPL = {
  invoice: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
  shipped: '33333333-3333-4333-8333-333333333333',
  delivered: '44444444-4444-4444-8444-444444444444',
  cod: '55555555-5555-4555-8555-555555555555',
};

/** A registry built against an explicit env — never the developer's real one. */
function registry(over: Record<string, string | undefined> = {}): TemplateRegistry {
  const keys = {
    QONTAK_INVOICE_TEMPLATE_ID: TPL.invoice,
    QONTAK_ORDER_TEMPLATE_ID: TPL.order,
    QONTAK_SHIPPED_TEMPLATE_ID: TPL.shipped,
    QONTAK_DELIVERED_TEMPLATE_ID: TPL.delivered,
    QONTAK_COD_TEMPLATE_ID: TPL.cod,
    ...over,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(keys)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const r = new TemplateRegistry();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return r;
}

const ACCOUNT = {
  id: 'pa-1',
  bankName: 'BCA',
  bankCode: '014',
  accountName: 'Bakso Mas Sular',
  accountNumber: '1234567890',
};

function outbox(over: Record<string, unknown>): NotificationOutbox {
  return {
    id: 'notif-1',
    channel: NotificationChannel.WHATSAPP,
    recipient: CUSTOMER_PHONE,
    template: 'order.transfer',
    payload: {},
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(),
    lockedUntil: null,
    lockedBy: null,
    providerMessageId: null,
    lastError: null,
    sourceMessageId: 'msg-1',
    createdAt: new Date(),
    sentAt: null,
    ...over,
  } as NotificationOutbox;
}

/** Build → send through the real provider, returning the captured Qontak body. */
async function capture(row: NotificationOutbox, reg = registry()) {
  const builder = new NotificationMessageBuilder(
    { getActiveAccount: async () => ACCOUNT } as never,
    reg,
  );
  const message = await builder.build(row);
  const sent: Record<string, unknown>[] = [];
  const provider = new QontakWhatsAppProvider(
    { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 1000, maxRetry: 1 } as never,
    reg as never,
  );
  (provider as unknown as { http: unknown }).http = async (_u: string, init: { body?: string }) => {
    sent.push(JSON.parse(String(init.body)));
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: 'q1' } }) };
  };
  await provider.send(message);
  return { body: sent[0], message };
}

const params = (body: Record<string, unknown>) =>
  ((body.parameters as Record<string, unknown>).body as { key: string; value: string; value_text: string }[]);
const buttons = (body: Record<string, unknown>) =>
  ((body.parameters as Record<string, unknown>).buttons as { value: string }[] | undefined);

// ------------------------------------------------------- order created ------

function consumer(orderOver: Record<string, unknown> = {}, cfgOver: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    notificationOutbox: { create: jest.fn((a: { data: Record<string, unknown> }) => void created.push(a.data)) },
    processedEvent: { create: jest.fn() },
  };
  const prisma = {
    processedEvent: { findUnique: jest.fn().mockResolvedValue(null) },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: ORDER_ID,
        orderNumber: ORDER_NO,
        totalPrice: 154_378,
        paymentMethod: 'BANK_TRANSFER',
        shippingProvider: 'paxel',
        shippingService: 'PAXEL_INSTANT',
        shippingServiceName: 'Paxel Instant',
        user: { name: 'Budi', email: 'budi@test.com', phone: CUSTOMER_PHONE },
        address: { phone: CUSTOMER_PHONE },
        payment: { status: 'PENDING' },
        ...orderOver,
      }),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const c = new OrderCreatedNotificationConsumer(
    prisma as never, {} as never, {} as never,
    { ...loadConsumersConfig({}), opsNotificationWhatsapp: ADMIN_PHONE, ...cfgOver } as never,
  );
  return { c, created };
}

const runCreated = (h: ReturnType<typeof consumer>, payload: Record<string, unknown> = {}) =>
  h.c.process('msg-1', {
    name: 'order.created',
    payload: { orderId: ORDER_ID, uploadUrl: `http://localhost:3000/payments/upload/${UPLOAD_TOKEN}`, ...payload },
  });

const rowFor = (created: Record<string, unknown>[], t: string) => created.find((r) => r.template === t);

describe('WA — order created', () => {
  it('WA-001 BANK_TRANSFER produces a customer invoice row', async () => {
    const h = consumer();
    await runCreated(h);
    expect(rowFor(h.created, 'order.transfer')).toBeDefined();
  });

  it('WA-003 the invoice is addressed to the customer, not the admin', async () => {
    const h = consumer();
    await runCreated(h);
    expect(rowFor(h.created, 'order.transfer')!.recipient).toBe(CUSTOMER_PHONE);
    expect(rowFor(h.created, 'order.transfer')!.recipient).not.toBe(ADMIN_PHONE);
  });

  it('WA-002 the invoice resolves QONTAK_INVOICE_TEMPLATE_ID', async () => {
    const { body } = await capture(outbox({
      template: 'order.transfer',
      payload: { orderNumber: ORDER_NO, totalPrice: 154_378, customerName: 'Budi', customerPhone: CUSTOMER_PHONE, uploadToken: UPLOAD_TOKEN },
    }));
    expect(body.message_template_id).toBe(TPL.invoice);
    expect(body.message_template_id).not.toBe(TPL.order); // never the admin template
  });

  it('WA-004 the invoice carries exactly 6 parameters in the contracted order', async () => {
    const { body } = await capture(outbox({
      template: 'order.transfer',
      payload: { orderNumber: ORDER_NO, totalPrice: 154_378, customerName: 'Budi', customerPhone: CUSTOMER_PHONE, uploadToken: UPLOAD_TOKEN },
    }));
    const p = params(body);
    expect(p).toHaveLength(6);
    expect(p.map((x) => x.key)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(p.map((x) => x.value)).toEqual([
      'customer_name', 'order_no', 'price', 'bank_name', 'account_name', 'account_number',
    ]);
    expect(p[0].value_text).toBe('Budi');
    expect(p[1].value_text).toBe(ORDER_NO);
    expect(p[2].value_text).toBe('Rp 154.378');          // currency-formatted
    expect(p[3].value_text).toBe(ACCOUNT.bankName);       // from the active PaymentAccount (DB)
    expect(p[4].value_text).toBe(ACCOUNT.accountName);
    expect(p[5].value_text).toBe(ACCOUNT.accountNumber);
  });

  it('WA-005 the invoice CTA carries the RAW upload token, not an order id', async () => {
    const { body } = await capture(outbox({
      template: 'order.transfer',
      payload: { orderNumber: ORDER_NO, totalPrice: 1, customerName: 'Budi', customerPhone: CUSTOMER_PHONE, uploadToken: UPLOAD_TOKEN },
    }));
    expect(buttons(body)).toEqual([{ index: '0', type: 'url', value: UPLOAD_TOKEN }]);
    expect(buttons(body)![0].value).not.toBe(ORDER_ID);
    expect(buttons(body)![0].value).not.toContain('http'); // template supplies the base URL
  });

  it('WA-006 an admin new-order row is created alongside the customer row', async () => {
    const h = consumer();
    await runCreated(h);
    expect(h.created).toHaveLength(2);
    expect(rowFor(h.created, 'order.new')).toBeDefined();
  });

  it('WA-008 the admin row is addressed to QONTAK_ADMIN, never the customer', async () => {
    const h = consumer();
    await runCreated(h);
    const admin = rowFor(h.created, 'order.new')!;
    expect(admin.recipient).toBe(ADMIN_PHONE);
    expect(admin.recipient).not.toBe(CUSTOMER_PHONE);
    // Even if a customer phone leaked into the payload, the builder must not use it.
    const { message } = await capture(outbox({
      template: 'order.new',
      recipient: ADMIN_PHONE,
      payload: { ...(admin.payload as Record<string, unknown>), customerPhone: CUSTOMER_PHONE },
    }));
    expect(message.recipient.phone).toBe(ADMIN_PHONE);
  });

  it('WA-007 the admin row resolves QONTAK_ORDER_TEMPLATE_ID', async () => {
    const h = consumer();
    await runCreated(h);
    const { body } = await capture(outbox({
      template: 'order.new', recipient: ADMIN_PHONE,
      payload: rowFor(h.created, 'order.new')!.payload,
    }));
    expect(body.message_template_id).toBe(TPL.order);
    expect(body.message_template_id).not.toBe(TPL.invoice);
  });

  it('WA-009 the admin row carries exactly 6 parameters, method and status separate', async () => {
    const h = consumer();
    await runCreated(h);
    const { body } = await capture(outbox({
      template: 'order.new', recipient: ADMIN_PHONE,
      payload: rowFor(h.created, 'order.new')!.payload,
    }));
    const p = params(body);
    expect(p).toHaveLength(6);
    expect(p.map((x) => x.value)).toEqual([
      'order_no', 'customer_name', 'total', 'payment_method', 'payment_status', 'shipping_method',
    ]);
    expect(p[0].value_text).toBe(ORDER_NO);
    expect(p[3].value_text).toBe('BANK_TRANSFER');   // {{4}} method alone
    expect(p[4].value_text).toBe('PENDING');         // {{5}} status alone
    expect(p[5].value_text).toBe('paxel · Paxel Instant');
  });

  it('WA-010 the admin CTA is the identifier the admin route needs, not a URL', async () => {
    const h = consumer();
    await runCreated(h);
    const { body } = await capture(outbox({
      template: 'order.new', recipient: ADMIN_PHONE,
      payload: rowFor(h.created, 'order.new')!.payload,
    }));
    // admin/app/orders/[id] resolves Order.id; orderNumber is not accepted there.
    expect(buttons(body)).toEqual([{ index: '0', type: 'url', value: ORDER_ID }]);
    expect(buttons(body)![0].value).not.toContain('http'); // no doubled base URL
    expect(buttons(body)![0].value).not.toBe(ORDER_NO);
  });

  it('WA-020 GATEWAY produces the admin row but NO transfer invoice', async () => {
    const h = consumer({ paymentMethod: 'GATEWAY' });
    // No uploadUrl: checkout issues a token only for BANK_TRANSFER/QRIS.
    await runCreated(h, { uploadUrl: undefined });
    expect(rowFor(h.created, 'order.transfer')).toBeUndefined();
    expect(rowFor(h.created, 'order.new')).toBeDefined();
    expect(h.created).toHaveLength(1);
  });

  it('the operator row correlation id fits NotificationOutbox.sourceMessageId', () => {
    // VarChar(36). The relay passes messageId = OutboxEvent.id, a 36-char uuid,
    // so `${messageId}:ops` was 40 and the insert threw — rolling back the whole
    // transaction, customer invoice included.
    const uuid = '0e2b1f3c-9a44-4c6e-b1d2-7f5a3c8e9d10';
    expect(uuid).toHaveLength(36);
    const ops = opsSourceMessageId(uuid);
    expect(ops.length).toBeLessThanOrEqual(36);
    expect(ops.endsWith(':ops')).toBe(true);
    expect(ops).not.toBe(uuid); // still distinct from the customer row's key
  });

  it('WA-021 COD still produces the COD template, unchanged', async () => {
    const h = consumer({ paymentMethod: 'COD' });
    await runCreated(h, { uploadUrl: undefined });
    expect(rowFor(h.created, 'order.cod')).toBeDefined();
    const { body } = await capture(outbox({
      template: 'order.cod',
      payload: { orderNumber: ORDER_NO, totalPrice: 1, customerName: 'Budi', customerPhone: CUSTOMER_PHONE },
    }));
    expect(body.message_template_id).toBe(TPL.cod);
    expect(params(body)).toHaveLength(4);
  });
});

// ------------------------------------------------------- shipped/delivered --

describe('WA — shipped and delivered', () => {
  const shipmentPayload = {
    orderId: ORDER_ID, orderNumber: ORDER_NO, customerName: 'Budi',
    customerPhone: CUSTOMER_PHONE, shippingProvider: 'JNE',
    shippingService: 'REG', trackingNumber: 'JNE0001234567',
  };

  it('WA-011 / WA-012 shipped resolves QONTAK_SHIPPED_TEMPLATE_ID for the customer', async () => {
    const { body, message } = await capture(outbox({ template: 'order.shipped', payload: shipmentPayload }));
    expect(body.message_template_id).toBe(TPL.shipped);
    expect(message.recipient.phone).toBe(CUSTOMER_PHONE);
  });

  it('WA-013 shipped carries exactly 4 parameters: name, order, courier, AWB', async () => {
    const { body } = await capture(outbox({ template: 'order.shipped', payload: shipmentPayload }));
    const p = params(body);
    expect(p).toHaveLength(4);
    expect(p.map((x) => x.value)).toEqual(['customer_name', 'order_no', 'courier', 'tracking']);
    expect(p.map((x) => x.value_text)).toEqual(['Budi', ORDER_NO, 'JNE', 'JNE0001234567']);
    expect(buttons(body)).toBeUndefined();
  });

  it('WA-014 / WA-015 delivered resolves QONTAK_DELIVERED_TEMPLATE_ID for the customer', async () => {
    const { body, message } = await capture(outbox({ template: 'order.delivered', payload: shipmentPayload }));
    expect(body.message_template_id).toBe(TPL.delivered);
    expect(message.recipient.phone).toBe(CUSTOMER_PHONE);
  });

  it('WA-016 delivered carries exactly 2 parameters: name and order number', async () => {
    const { body } = await capture(outbox({ template: 'order.delivered', payload: shipmentPayload }));
    const p = params(body);
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.value)).toEqual(['customer_name', 'order_no']);
    expect(p.map((x) => x.value_text)).toEqual(['Budi', ORDER_NO]);
    // No courier/tracking leaks into a template that has no slot for them.
    expect(JSON.stringify(p)).not.toContain('JNE0001234567');
  });
});

// ------------------------------------------------- config + gate + failure --

describe('WA — configuration and delivery safety', () => {
  it('an unconfigured template is terminally unresolvable, never silently sent', () => {
    const reg = registry({ QONTAK_INVOICE_TEMPLATE_ID: undefined });
    expect(() => reg.resolve(NotificationChannel.WHATSAPP, 'order.transfer')).toThrow(
      /Provider template id missing for WHATSAPP\/order\.transfer/,
    );
  });

  it('the four lifecycle templates map to four DISTINCT ids', () => {
    const reg = registry();
    const ids = (['order.transfer', 'order.new', 'order.shipped', 'order.delivered'] as const).map(
      (t) => reg.resolve(NotificationChannel.WHATSAPP, t).providerTemplateId,
    );
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([TPL.invoice, TPL.order, TPL.shipped, TPL.delivered]);
  });

  it('WA-023 the gate admits an explicitly allowlisted recipient', () => {
    const gate = new NotificationDeliveryGate(
      loadNotificationDeliveryConfig({
        NOTIFICATION_DELIVERY_ENABLED: 'true',
        NOTIFICATION_ALLOWED_RECIPIENTS: `0${CUSTOMER_PHONE.slice(2)}`, // written 08…, matched as 628…
      }),
    );
    expect(() =>
      gate.assertDeliverable({
        channel: NotificationChannel.WHATSAPP,
        recipient: { name: 'Budi', phone: CUSTOMER_PHONE },
      } as never),
    ).not.toThrow();
  });

  it('WA-024 a recipient outside the allowlist is blocked, and an empty allowlist blocks everything', () => {
    const allowOne = new NotificationDeliveryGate(
      loadNotificationDeliveryConfig({
        NOTIFICATION_DELIVERY_ENABLED: 'true',
        NOTIFICATION_ALLOWED_RECIPIENTS: '6289990000000',
      }),
    );
    expect(() =>
      allowOne.assertDeliverable({
        channel: NotificationChannel.WHATSAPP, recipient: { name: 'Budi', phone: CUSTOMER_PHONE },
      } as never),
    ).toThrow(NotificationBlockedError);

    const allowNone = new NotificationDeliveryGate(
      loadNotificationDeliveryConfig({ NOTIFICATION_DELIVERY_ENABLED: 'true' }),
    );
    expect(() =>
      allowNone.assertDeliverable({
        channel: NotificationChannel.WHATSAPP, recipient: { name: 'Budi', phone: CUSTOMER_PHONE },
      } as never),
    ).toThrow(/NOTIFICATION_ALLOWED_RECIPIENTS is empty/);
  });

  it('WA-022 a Qontak 5xx is transient, so the row stays retryable', async () => {
    const reg = registry();
    const builder = new NotificationMessageBuilder({ getActiveAccount: async () => ACCOUNT } as never, reg);
    const message = await builder.build(outbox({ template: 'order.delivered', payload: { orderNumber: ORDER_NO, customerName: 'Budi', customerPhone: CUSTOMER_PHONE } }));
    const provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 500, maxRetry: 0 } as never,
      reg as never,
    );

    (provider as unknown as { http: unknown }).http = async () => ({
      status: 503, headers: { get: () => null }, text: async () => 'upstream down',
    });
    await expect(provider.send(message)).rejects.toBeInstanceOf(TransientSendError);
  });
});
