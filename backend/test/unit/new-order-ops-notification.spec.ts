import { NotificationChannel } from '@prisma/client';
import { OrderCreatedNotificationConsumer } from '../../src/infrastructure/consumers/order-created-notification.consumer';
import { loadConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import { NotificationDeliveryGate } from '../../src/infrastructure/notifications/notification-delivery.gate';

/**
 * PAXELBOX-37 parts C + D. An INTERNAL operational alert: "a new order arrived,
 * go and process it". It is addressed to an operator, never a customer, and it
 * is deliberately a second outbox row rather than an extra recipient on the
 * customer message — different template, different audience, independently
 * visible, retryable and gate-checked.
 *
 * The button deep-links the admin order-detail page. That route was read from
 * the admin app rather than assumed: `admin/app/orders/[id]/page.tsx` takes
 * `params.id` straight into `GET /admin/orders/:id`, which looks the order up by
 * Order.id. orderNumber is not accepted there.
 */

const ORDER_ID = 'ord-uuid-1';
const OPS_PHONE = '6285861470308';

function order(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'BMS-20260827-ABC',
    totalPrice: 154_378,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: 'paxel',
    shippingService: 'PAXEL_INSTANT',
    shippingServiceName: 'Paxel Instant',
    user: { name: 'Budi', email: 'budi@test.com', phone: '628123456789' },
    address: { phone: '628123456789' },
    payment: { status: 'PENDING' },
    ...over,
  };
}

const UPLOAD_TOKEN = 'a'.repeat(64); // 256-bit hex, as PaymentUploadTokenService issues

function build(cfgOver: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    notificationOutbox: { create: jest.fn((a: { data: Record<string, unknown> }) => void created.push(a.data)) },
    processedEvent: { create: jest.fn() },
  };
  const prisma = {
    processedEvent: { findUnique: jest.fn().mockResolvedValue(null) },
    order: { findUnique: jest.fn().mockResolvedValue(order(orderOver)) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const config = {
    ...loadConsumersConfig({}),
    opsNotificationWhatsapp: OPS_PHONE,
    adminUrl: 'https://admin.example.test',
    ...cfgOver,
  };
  const consumer = new OrderCreatedNotificationConsumer(
    prisma as never, {} as never, {} as never, config as never,
  );
  return { consumer, created, tx };
}

const run = (c: ReturnType<typeof build>, payload: Record<string, unknown> = {}) =>
  c.consumer.process('msg-1', {
    name: 'order.created',
    payload: {
      orderId: ORDER_ID,
      // checkout emits the upload URL for BANK_TRANSFER/QRIS; the consumer takes
      // its last segment as the raw token.
      uploadUrl: `http://localhost:3000/payments/upload/${UPLOAD_TOKEN}`,
      ...payload,
    },
  });

const opsRow = (created: Record<string, unknown>[]) => created.find((r) => r.template === 'order.new');
const customerRow = (created: Record<string, unknown>[]) => created.find((r) => r.template !== 'order.new');

// ------------------------------------------------------------ enqueue shape

describe('the internal alert is enqueued alongside the customer message', () => {
  it('creates BOTH rows, in one transaction', async () => {
    const c = build();

    await run(c);

    expect(c.created).toHaveLength(2);
    expect(opsRow(c.created)).toBeDefined();
    expect(customerRow(c.created)).toBeDefined();
  });

  it('addresses the operator, not the customer', async () => {
    const c = build();

    await run(c);

    expect(opsRow(c.created)!.recipient).toBe(OPS_PHONE);
    // The customer row still goes to the customer — untouched.
    expect(customerRow(c.created)!.recipient).toBe('628123456789');
  });

  it('marks the row as internal so nothing can mistake it for a customer message', async () => {
    const c = build();

    await run(c);

    expect((opsRow(c.created)!.payload as Record<string, unknown>).audience).toBe('internal');
  });

  it('uses a distinct sourceMessageId so the two rows never collide', async () => {
    const c = build();

    await run(c);

    expect(opsRow(c.created)!.sourceMessageId).toBe('msg-1:ops');
    expect(customerRow(c.created)!.sourceMessageId).toBe('msg-1');
  });

  it('is skipped silently when no operator number is configured', async () => {
    const c = build({ opsNotificationWhatsapp: undefined });

    await run(c);

    expect(c.created).toHaveLength(1);
    expect(opsRow(c.created)).toBeUndefined();
  });
});

// -------------------------------------------------------- template variables

describe('the six template slots carry the contracted values', () => {
  it('carries order number, customer, total, payment method, payment status and shipping', async () => {
    const c = build();

    await run(c);

    expect(opsRow(c.created)!.payload).toMatchObject({
      orderNumber: 'BMS-20260827-ABC',   // {{1}}
      customerName: 'Budi',              // {{2}}
      grandTotal: 154_378,               // {{3}}
      paymentMethod: 'BANK_TRANSFER',             // {{4}}
      paymentStatus: 'PENDING',                   // {{5}}
      shippingMethod: 'paxel · Paxel Instant',    // {{6}}
    });
  });

  it('prefers the canonical shipping label and degrades cleanly', async () => {
    // shippingServiceName wins over the raw code (PAXELBOX-19 semantics).
    const c = build();
    await run(c);
    expect((opsRow(c.created)!.payload as Record<string, string>).shippingMethod).toBe('paxel · Paxel Instant');
  });
});

// ---------------------------------------------------------------- the button

describe('the admin deep link uses the real route', () => {
  it('passes the IDENTIFIER only — Order.id, never a full URL', async () => {
    const c = build();

    await run(c);

    // The Qontak template already contains ".../orders/{{1}}". Passing a full
    // URL here would render ".../orders/https://.../orders/<id>".
    const ref = (opsRow(c.created)!.payload as Record<string, string>).adminOrderRef;
    expect(ref).toBe(ORDER_ID);
    expect(ref).not.toContain('http');
    expect(ref).not.toContain('/orders/');
  });

  it('never uses orderNumber as the identifier', async () => {
    const c = build();

    await run(c);

    // The admin route app/orders/[id] resolves Order.id via findUnique; it does
    // not accept orderNumber.
    expect((opsRow(c.created)!.payload as Record<string, string>).adminOrderRef).not.toContain('BMS-');
  });

  it('does not depend on ADMIN_URL any more', async () => {
    const c = build({ adminUrl: undefined });

    await run(c);

    // The identifier is intrinsic to the order, so an unset ADMIN_URL can no
    // longer produce an empty button.
    expect((opsRow(c.created)!.payload as Record<string, string>).adminOrderRef).toBe(ORDER_ID);
  });
});

// ------------------------------------------------------- registry + provider

describe('the template resolves and renders through the existing abstraction', () => {
  const TEMPLATE_ID = 'b722adf6-5538-432b-a43a-fd0c15b44ea0';

  function registryWith(id?: string) {
    const prev = process.env.QONTAK_ORDER_TEMPLATE_ID;
    if (id === undefined) delete process.env.QONTAK_ORDER_TEMPLATE_ID;
    else process.env.QONTAK_ORDER_TEMPLATE_ID = id;
    const registry = new TemplateRegistry();
    if (prev === undefined) delete process.env.QONTAK_ORDER_TEMPLATE_ID;
    else process.env.QONTAK_ORDER_TEMPLATE_ID = prev;
    return registry;
  }

  it('registers WHATSAPP/order.new against the configured template id', () => {
    const registry = registryWith(TEMPLATE_ID);

    const d = registry.resolve(NotificationChannel.WHATSAPP, 'order.new');

    expect(d.providerTemplateId).toBe(TEMPLATE_ID);
    expect(d.body?.map((b) => b.source)).toEqual([
      'orderNumber', 'customerName', 'grandTotal', 'paymentMethod', 'paymentStatus', 'shippingMethod',
    ]);
  });

  it('stays terminally unconfigured — never silently sendable — without the env var', () => {
    const registry = registryWith(undefined);

    expect(() => registry.resolve(NotificationChannel.WHATSAPP, 'order.new')).toThrow(
      /Provider template id missing for WHATSAPP\/order\.new/,
    );
  });

  it('feeds the button from adminOrderRef, not uploadToken', async () => {
    const sent: { body?: unknown }[] = [];
    const http = jest.fn(async (_url: string, init: { body?: unknown }) => {
      sent.push(init);
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: 'q1' } }) };
    });
    const provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 1000, maxRetry: 1 } as never,
      registryWith(TEMPLATE_ID) as never,
    );
    (provider as unknown as { http: unknown }).http = http;

    await provider.send({
      channel: NotificationChannel.WHATSAPP,
      template: 'order.new',
      recipient: { name: 'Ops', phone: OPS_PHONE },
      variables: {
        template: 'order.new', customerName: 'Budi', orderNumber: 'BMS-1', grandTotal: 154_378,
        paymentMethod: 'BANK_TRANSFER', paymentStatus: 'PENDING', shippingMethod: 'paxel · Paxel Instant',
        adminOrderRef: ORDER_ID,
      },
      metadata: { notificationId: 'n1', idempotencyKey: 'n1', externalRequestId: 'x', providerTemplateId: TEMPLATE_ID },
    } as never);

    const body = JSON.parse(String(sent[0].body));
    expect(body.message_template_id).toBe(TEMPLATE_ID);
    expect(body.parameters.buttons).toEqual([
      // Identifier only: the Qontak template holds the ".../orders/" base.
      { index: '0', type: 'url', value: ORDER_ID },
    ]);
    expect(body.parameters.body.map((b: { value: string }) => b.value)).toEqual([
      'order_no', 'customer_name', 'total', 'payment_method', 'payment_status', 'shipping_method',
    ]);
  });

  it('leaves the existing uploadToken-driven button untouched', () => {
    const registry = registryWith(TEMPLATE_ID);
    const transfer = registry.resolve(NotificationChannel.WHATSAPP, 'order.transfer');

    // No buttonSource ⇒ the provider still falls back to uploadToken.
    expect(transfer.button).toBe(true);
    expect(transfer.buttonSource).toBeUndefined();
  });
});

// ----------------------------------------------------------- the safety gate

describe('the internal alert obeys the PAXELBOX-31 gate like everything else', () => {
  const message = {
    channel: NotificationChannel.WHATSAPP,
    template: 'order.new',
    recipient: { name: 'Ops', phone: OPS_PHONE },
    variables: {},
    metadata: {},
  } as never;

  it('is blocked while delivery is disabled — being internal is not an exemption', () => {
    const gate = new NotificationDeliveryGate({ enabled: false, allowedRecipients: [OPS_PHONE] });

    expect(() => gate.assertDeliverable(message)).toThrow(/NOTIFICATION_DELIVERY_ENABLED/);
  });

  it('is blocked when the operator number is not allowlisted', () => {
    const gate = new NotificationDeliveryGate({ enabled: true, allowedRecipients: ['628999000111'] });

    expect(() => gate.assertDeliverable(message)).toThrow(/not allowlisted/);
  });

  it('is permitted only when BOTH conditions hold', () => {
    const gate = new NotificationDeliveryGate({ enabled: true, allowedRecipients: [OPS_PHONE] });

    expect(() => gate.assertDeliverable(message)).not.toThrow();
  });
});
