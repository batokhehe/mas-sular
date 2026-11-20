/**
 * EMAIL notification channel switch.
 *
 * Email delivery is OFF unless NOTIFICATION_EMAIL_ENABLED is exactly "true" (fail
 * closed, like NOTIFICATION_DELIVERY_ENABLED). It covers the EMAIL channel only:
 *   - the payment-notification consumer stops creating EMAIL outbox rows (the
 *     event is acknowledged as skipped, so nothing piles up in a queue);
 *   - the delivery gate refuses to send any EMAIL row that still reaches it;
 *   - manual (admin) EMAIL sends and EMAIL resends are refused up front.
 *
 * WhatsApp, the outbox history, and every payment/shipment workflow are untouched:
 * no payment, order or shipment state depends on an email being sent.
 */
export const EMAIL_CHANNEL_ENV = 'NOTIFICATION_EMAIL_ENABLED';

export const EMAIL_CHANNEL_DISABLED_REASON = `EMAIL channel is disabled (${EMAIL_CHANNEL_ENV} is not "true")`;

export function isEmailChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EMAIL_CHANNEL_ENV] === 'true';
}
