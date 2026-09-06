import { nonNegativeInt as positiveInt } from '../../common/utils/number.util';
export const QONTAK_CONFIG = 'QONTAK_CONFIG';

export interface QontakConfig {
  baseUrl: string;
  apiToken?: string;
  channelIntegrationId?: string;
  /**
   * CUSTOMER invoice / payment instruction (bank details + upload-proof CTA).
   *
   * 61AG.3.28: this is QONTAK_INVOICE_TEMPLATE_ID. It previously read
   * QONTAK_ORDER_TEMPLATE_ID, which left QONTAK_INVOICE_TEMPLATE_ID configured
   * but never referenced — the customer invoice was sent under the template id
   * meant for the admin alert.
   */
  invoiceTemplateId?: string;
  /** ADMIN "Pesanan Baru" operational alert. QONTAK_ORDER_TEMPLATE_ID. */
  orderTemplateId?: string;
  codTemplateId?: string;
  shippedTemplateId?: string; // "Pesanan Anda telah dikirim"
  deliveredTemplateId?: string; // delivery confirmation
  shipmentTemplateId?: string; // generic shipment status update
  /**
   * Operational WhatsApp recipient for the admin alert (QONTAK_ADMIN). Stored as
   * configured; the builder normalises it like any other recipient.
   */
  adminRecipient?: string;
  /** Approved free-text template ({{1}} = message) for admin manual sends. Optional — without it, manual WhatsApp sends are rejected at the API. */
  manualTemplateId?: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** In-call immediate retries for transient network/5xx (complements the durable outbox retry). */
  maxRetry: number;
}

export function loadQontakConfig(env: NodeJS.ProcessEnv = process.env): QontakConfig {
  return {
    baseUrl: (env.QONTAK_BASE_URL ?? 'https://service-chat.qontak.com').replace(/\/+$/, ''),
    apiToken: env.QONTAK_API_TOKEN,
    channelIntegrationId: env.QONTAK_CHANNEL_INTEGRATION_ID,
    invoiceTemplateId: env.QONTAK_INVOICE_TEMPLATE_ID,
    orderTemplateId: env.QONTAK_ORDER_TEMPLATE_ID,
    codTemplateId: env.QONTAK_COD_TEMPLATE_ID,
    shippedTemplateId: env.QONTAK_SHIPPED_TEMPLATE_ID,
    deliveredTemplateId: env.QONTAK_DELIVERED_TEMPLATE_ID,
    shipmentTemplateId: env.QONTAK_SHIPMENT_TEMPLATE_ID,
    adminRecipient: env.QONTAK_ADMIN,
    manualTemplateId: env.QONTAK_MANUAL_TEMPLATE_ID,
    timeoutMs: positiveInt(env.QONTAK_TIMEOUT_MS, 10_000),
    maxRetry: positiveInt(env.QONTAK_MAX_RETRY, 1),
  };
}

/** Fail-fast: required when WhatsApp delivery is actually enabled. */
export function assertQontakConfigured(config: QontakConfig): void {
  const missing: string[] = [];
  if (!config.apiToken) missing.push('QONTAK_API_TOKEN');
  if (!config.channelIntegrationId) missing.push('QONTAK_CHANNEL_INTEGRATION_ID');
  if (!config.invoiceTemplateId) missing.push('QONTAK_INVOICE_TEMPLATE_ID');
  if (!config.orderTemplateId) missing.push('QONTAK_ORDER_TEMPLATE_ID');
  if (!config.codTemplateId) missing.push('QONTAK_COD_TEMPLATE_ID');
  if (!config.shippedTemplateId) missing.push('QONTAK_SHIPPED_TEMPLATE_ID');
  if (!config.deliveredTemplateId) missing.push('QONTAK_DELIVERED_TEMPLATE_ID');
  if (!config.adminRecipient) missing.push('QONTAK_ADMIN');
  if (missing.length) {
    throw new Error(`WhatsApp (Qontak) notifications require: ${missing.join(', ')}`);
  }
}
