import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { PaymentUploadTokenService } from '../../modules/payments/payment-upload-token.service';
import { NotificationMessage } from './notification-message';

/**
 * S1 phase 2: late binding of the payment-upload link.
 *
 * The raw upload token used to be minted at checkout / reminder time and carried
 * through OutboxEvent, RabbitMQ (incl. retry queue + DLQ) and NotificationOutbox
 * as plaintext. Now none of those carry it: the row only identifies the payment,
 * and this binder mints a FRESH single-use token immediately before provider
 * delivery. Only the token's SHA-256 hash is stored (PaymentUploadToken); the
 * raw value exists only in the returned in-memory message.
 *
 * Retry / resend semantics (deliberate):
 * - Every delivery attempt mints its own token. A timeout or 5xx after the
 *   provider may already have delivered message A must not leave the customer
 *   without a working link, so earlier tokens are NEVER revoked here: each one
 *   stays valid until it is used or expires (72h).
 * - Receipt semantics are the EXISTING payment rules, unchanged by S1: a receipt
 *   may be uploaded while the payment is PENDING or WAITING_VERIFICATION
 *   (PaymentsService UPLOADABLE_STATUSES). Each token is single-use, but a
 *   second valid token (another attempt's link, a reminder's link, or the
 *   signed-in upload) can REPLACE the receipt while the payment still awaits
 *   verification; the last successful upload wins and emits its own
 *   payment.receipt_uploaded. Once the payment is PAID or terminal, every link
 *   is refused (409). Multiple valid tokens per payment already existed before
 *   S1 (reminders minted their own); what S1 changes is only that a WhatsApp
 *   retry now carries a NEW link instead of re-sending the same one.
 * - The provider idempotency key stays NotificationOutbox.id, so a provider that
 *   deduplicates keeps showing the first delivered message (and its still-valid
 *   link); a provider that does not dedupe delivers a second, also-valid link.
 * - A token minted for an attempt that never reached the customer is an
 *   unusable-in-practice hash row (the secret was never stored or delivered).
 *   It expires after 72h and the retention sweep deletes it later. At most one
 *   such row per attempt (bounded by the sender's maxAttempts).
 * - The token is committed BEFORE the provider call, so a link is never
 *   delivered for a token row that does not exist.
 */
@Injectable()
export class UploadLinkBinder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PaymentUploadTokenService,
  ) {}

  /** Returns a copy of `message` with the upload token bound; non-link messages pass through. */
  async bind(message: NotificationMessage): Promise<NotificationMessage> {
    const ref = message.uploadLinkFor;
    if (!ref) return message;
    if (message.variables.template !== 'order.transfer') {
      throw new ConfigurationError(`notification ${message.metadata.notificationId}: upload link requested for unsupported template ${message.variables.template}`);
    }

    let paymentId = ref.paymentId;
    if (!paymentId && ref.orderId) {
      // Pre-S1 rows identify only the order; Payment.orderId is unique.
      const payment = await this.prisma.payment.findUnique({ where: { orderId: ref.orderId }, select: { id: true } });
      paymentId = payment?.id;
    }
    if (!paymentId) {
      // Same terminal class as the old "missing uploadToken": never send a
      // transfer message without its upload button.
      throw new ConfigurationError(`notification ${message.metadata.notificationId}: no payment found to issue an upload link for`);
    }

    // Committed on its own (no surrounding transaction) before the provider call.
    const issued = await this.tokens.issue(this.prisma, paymentId);
    return { ...message, variables: { ...message.variables, uploadToken: issued.rawToken } };
  }
}
