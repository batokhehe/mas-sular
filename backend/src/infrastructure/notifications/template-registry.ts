import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { loadQontakConfig, QontakConfig } from './qontak.config';
import { NotificationTemplate } from './notification-message';

/** One Qontak body parameter: which variable feeds which template slot. */
export interface QontakBodyParam {
  key: string; // "1".."6"
  valueName: string; // e.g. "customer_name"
  source: string; // variable key on NotificationVariables
  format?: 'currency';
}

/**
 * Descriptor-based template mapping. Resolving (channel, logicalTemplate) yields
 * the provider template id + (for WhatsApp) the parameter/button layout, so the
 * provider stays generic: adding a template is a registry change, not a code change.
 */
export interface ProviderTemplateDescriptor {
  /** Qontak message_template_id, or the renderer template key for EMAIL. */
  providerTemplateId: string;
  /** WhatsApp body parameter layout (undefined for non-templated channels). */
  body?: QontakBodyParam[];
  /** Include the dynamic-URL button. */
  button?: boolean;
  /**
   * Which variable feeds the button's URL slot. Defaults to `uploadToken`, the
   * only source that existed before PAXELBOX-37, so every template registered
   * before this field appeared keeps its exact behaviour.
   */
  buttonSource?: string;
}

@Injectable()
export class TemplateRegistry {
  private readonly map = new Map<string, ProviderTemplateDescriptor>();

  constructor() {
    const qontak: QontakConfig = loadQontakConfig();
    // EMAIL → renderer template key (EmailProvider renders text from variables).
    this.register(NotificationChannel.EMAIL, 'order.transfer', { providerTemplateId: 'order.transfer' });
    this.register(NotificationChannel.EMAIL, 'order.cod', { providerTemplateId: 'order.cod' });
    this.register(NotificationChannel.EMAIL, 'order.shipped', { providerTemplateId: 'order.shipped' });
    this.register(NotificationChannel.EMAIL, 'order.delivered', { providerTemplateId: 'order.delivered' });
    this.register(NotificationChannel.EMAIL, 'shipment.status', { providerTemplateId: 'shipment.status' });
    // Manual (admin-composed) templates — Customer Communication Center.
    this.register(NotificationChannel.EMAIL, 'manual.order-update', { providerTemplateId: 'manual.order-update' });
    this.register(NotificationChannel.EMAIL, 'manual.shipment-update', { providerTemplateId: 'manual.shipment-update' });
    this.register(NotificationChannel.EMAIL, 'manual.custom', { providerTemplateId: 'manual.custom' });

    // WHATSAPP → Qontak template ids + parameter layout.
    // CUSTOMER invoice: bank details + upload-proof button. QONTAK_INVOICE_TEMPLATE_ID.
    this.register(NotificationChannel.WHATSAPP, 'order.transfer', {
      providerTemplateId: qontak.invoiceTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
        { key: '3', valueName: 'price', source: 'totalPrice', format: 'currency' },
        { key: '4', valueName: 'bank_name', source: 'bankName' },
        { key: '5', valueName: 'account_name', source: 'accountName' },
        { key: '6', valueName: 'account_number', source: 'accountNumber' },
      ],
      button: true,
    });
    this.register(NotificationChannel.WHATSAPP, 'order.cod', {
      providerTemplateId: qontak.codTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
        { key: '3', valueName: 'price', source: 'totalPrice', format: 'currency' },
        { key: '4', valueName: 'delivery_info', source: 'deliveryInfo' },
      ],
      button: false,
    });
    // "Halo {{1}}, Pesanan Anda dengan nomor {{2}} sudah dikirim. Kurir {{3}}, Resi {{4}}"
    this.register(NotificationChannel.WHATSAPP, 'order.shipped', {
      providerTemplateId: qontak.shippedTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
        // `courier`, not `shippingProvider`: the canonical carrier name only.
        { key: '3', valueName: 'courier', source: 'courier' },
        { key: '4', valueName: 'tracking', source: 'trackingNumber' },
      ],
      button: false,
    });
    // "Halo {{1}}, Pesanan Anda dengan nomor {{2}} telah berhasil diterima."
    this.register(NotificationChannel.WHATSAPP, 'order.delivered', {
      providerTemplateId: qontak.deliveredTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
      ],
      button: false,
    });
    // Generic shipment status update — one template, status text supplied per event.
    this.register(NotificationChannel.WHATSAPP, 'shipment.status', {
      providerTemplateId: qontak.shipmentTemplateId ?? '',
      body: [
        { key: '1', valueName: 'status', source: 'statusLabel' },
        { key: '2', valueName: 'provider', source: 'shippingProvider' },
        { key: '3', valueName: 'tracking', source: 'trackingNumber' },
      ],
      button: false,
    });
    /**
     * ADMIN operational alert — "Pesanan Baru". Goes to QONTAK_ADMIN, never to a
     * customer, and its button deep-links the admin order-detail page.
     * Registered like every other template so it inherits the same outbox,
     * sender worker and PAXELBOX-31 delivery gate; nothing about it bypasses
     * the checks a customer message goes through.
     *
     * QONTAK_ORDER_TEMPLATE_ID (61AG.3.28). Payment method and payment status are
     * SEPARATE slots — they were previously one pre-joined "METHOD · STATUS"
     * string, which no six-slot template can render.
     */
    this.register(NotificationChannel.WHATSAPP, 'order.new', {
      providerTemplateId: qontak.orderTemplateId ?? '',
      body: [
        { key: '1', valueName: 'order_no', source: 'orderNumber' },
        { key: '2', valueName: 'customer_name', source: 'customerName' },
        { key: '3', valueName: 'total', source: 'grandTotal', format: 'currency' },
        { key: '4', valueName: 'payment_method', source: 'paymentMethod' },
        { key: '5', valueName: 'payment_status', source: 'paymentStatus' },
        { key: '6', valueName: 'shipping_method', source: 'shippingMethod' },
      ],
      button: true,
      // The Qontak template already carries the base URL as
      // ".../orders/{{1}}", so the button value is the IDENTIFIER ONLY.
      // Passing a full URL here would render ".../orders/https://.../orders/<id>".
      buttonSource: 'adminOrderRef',
    });
    // Manual sends share ONE approved free-text Qontak template ({{1}} = message).
    // resolve() rejects them with ConfigurationError until QONTAK_MANUAL_TEMPLATE_ID
    // is set, and the communication API pre-checks that before queueing.
    const manualBody = [{ key: '1', valueName: 'message', source: 'message' }];
    this.register(NotificationChannel.WHATSAPP, 'manual.order-update', { providerTemplateId: qontak.manualTemplateId ?? '', body: manualBody, button: false });
    this.register(NotificationChannel.WHATSAPP, 'manual.shipment-update', { providerTemplateId: qontak.manualTemplateId ?? '', body: manualBody, button: false });
    this.register(NotificationChannel.WHATSAPP, 'manual.custom', { providerTemplateId: qontak.manualTemplateId ?? '', body: manualBody, button: false });
  }

  private key(channel: NotificationChannel, template: NotificationTemplate): string {
    return `${channel}:${template}`;
  }

  private register(channel: NotificationChannel, template: NotificationTemplate, d: ProviderTemplateDescriptor): void {
    this.map.set(this.key(channel, template), d);
  }

  /** Resolve a descriptor; throws ConfigurationError when the pair is unknown/unconfigured. */
  resolve(channel: NotificationChannel, template: NotificationTemplate): ProviderTemplateDescriptor {
    const d = this.map.get(this.key(channel, template));
    if (!d) {
      throw new ConfigurationError(`No template registered for ${channel}/${template}`);
    }
    if (!d.providerTemplateId) {
      throw new ConfigurationError(`Provider template id missing for ${channel}/${template}`);
    }
    return d;
  }

  /** Boot-time check: every required (channel, template) pair resolves. */
  assertResolvable(pairs: Array<{ channel: NotificationChannel; template: NotificationTemplate }>): void {
    for (const p of pairs) this.resolve(p.channel, p.template);
  }
}
