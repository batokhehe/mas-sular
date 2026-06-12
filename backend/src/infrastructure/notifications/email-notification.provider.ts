import { Injectable, Logger } from '@nestjs/common';
import { NotificationProvider, NotificationSendInput, NotificationSendResult } from './notification-provider';

/**
 * Stub email provider. A real adapter would call the email API, passing
 * input.idempotencyKey as the provider idempotency key so a re-send (after a
 * crash before markSent) is deduped at the provider. Classify failures as
 * PermanentSendError (4xx — bad recipient) or TransientSendError (5xx/timeout).
 */
@Injectable()
export class EmailNotificationProvider implements NotificationProvider {
  readonly channel = 'EMAIL';
  private readonly logger = new Logger('EmailNotificationProvider');

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    this.logger.log(`[stub] email to ${input.recipient} (idempotencyKey=${input.idempotencyKey}): ${input.subject}`);
    return { providerMessageId: `stub-${input.idempotencyKey}` };
  }
}
