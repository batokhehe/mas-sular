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
            `${payload.orderNumber ?? ''} (total ${payload.totalPrice ?? ''}). Thank you!`,
        };
      default:
        throw new PermanentSendError(`Unknown notification template: ${template}`);
    }
  }
}
