import { Injectable } from '@nestjs/common';
import { PermanentSendError } from './notification-provider';

export interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * Renders a template id + payload snapshot into channel content. Templates live
 * in code (versionable without a data migration). An unknown template is a
 * permanent error (never retried).
 */
@Injectable()
export class TemplateRenderer {
  render(template: string, payload: Record<string, unknown>): RenderedMessage {
    switch (template) {
      case 'order.received':
        return {
          subject: `Order ${payload.orderNumber ?? ''} received`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we have received your order ` +
            `${payload.orderNumber ?? ''} (total ${payload.totalPrice ?? ''}). Thank you!` +
            // Non-COD orders carry an upload link so the customer can submit their receipt.
            (payload.uploadUrl ? ` To complete payment, upload your receipt here: ${payload.uploadUrl}` : ''),
        };
      case 'payment.approved':
        return {
          subject: `Payment received for order ${payload.orderNumber ?? ''}`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we have verified your payment for order ` +
            `${payload.orderNumber ?? ''}. Your order is now being processed.`,
        };
      case 'payment.rejected':
        return {
          subject: `Payment issue for order ${payload.orderNumber ?? ''}`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we could not verify your payment for order ` +
            `${payload.orderNumber ?? ''}. Please contact us or try paying again.`,
        };
      default:
        throw new PermanentSendError(`Unknown notification template: ${template}`);
    }
  }
}
