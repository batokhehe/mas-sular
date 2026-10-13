import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { InvalidPhoneError, maskPhone, normalizePhoneNumber } from '../../common/utils/phone.util';
import { NotificationMessage } from './notification-message';

export const NOTIFICATION_DELIVERY_CONFIG = 'NOTIFICATION_DELIVERY_CONFIG';

/**
 * Delivery was refused by policy, not attempted and rejected. Terminal, exactly
 * like ConfigurationError: retrying changes nothing until an operator changes
 * configuration, so the sender marks the row FAILED rather than backing off.
 *
 * The message is stored in NotificationOutbox.lastError and logged, so it must
 * never contain a full recipient — callers pass masked values only.
 */
export class NotificationBlockedError extends Error {
  constructor(reason: string) {
    super(`blocked by notification safety gate: ${reason}`);
    this.name = 'NotificationBlockedError';
  }
}

/**
 * Who may receive a delivered notification (production-readiness B6).
 *
 *   allowlist  only recipients listed in NOTIFICATION_ALLOWED_RECIPIENTS - the
 *              default, and the only policy development/test can run with;
 *   all        every legitimate customer recipient. Honored ONLY when
 *              NODE_ENV=production, and only as an explicit opt-in.
 *
 * `all` replaces the allowlist check and nothing else: delivery must still be
 * enabled, the recipient must still normalize to a usable phone/email, the sender
 * worker must still be running, and templates/credentials are still enforced by
 * their own configuration checks.
 */
export type NotificationRecipientPolicy = 'allowlist' | 'all';

export interface NotificationDeliveryConfig {
  /** Master delivery switch. Absent/anything-but-"true" ⇒ nothing is delivered. */
  enabled: boolean;
  /** Normalized recipients cleared for delivery. Empty ⇒ nothing is delivered (allowlist policy). */
  allowedRecipients: string[];
  /** Recipient policy. Absent means `allowlist`; only an explicit `all` widens it. */
  policy?: NotificationRecipientPolicy;
}

/**
 * Fail closed. Unset, misspelled or unknown values are `allowlist`, and so is `all`
 * outside production - env.validation rejects both at boot, and this keeps the
 * gate safe even if it is ever constructed without that validation.
 */
export function resolveRecipientPolicy(env: NodeJS.ProcessEnv = process.env): NotificationRecipientPolicy {
  const raw = env.NOTIFICATION_RECIPIENT_POLICY?.trim();
  return raw === 'all' && env.NODE_ENV === 'production' ? 'all' : 'allowlist';
}

/**
 * Normalize one recipient to its comparable form: emails case-folded, phones
 * through the SAME normalizer the builder uses, so an allowlist entry written
 * as `08…` matches a message whose recipient the builder rendered as `628…`.
 *
 * Returns null for anything unusable. A null NEVER matches, so a malformed
 * allowlist entry silently widens nothing — it only fails to authorize.
 */
export function normalizeRecipient(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  try {
    return normalizePhoneNumber(trimmed);
  } catch (err) {
    if (err instanceof InvalidPhoneError) return null;
    throw err;
  }
}

/** Mask for logs/lastError: `628****1234`, `ab***@example.com`. */
export function maskRecipient(value: string | null | undefined): string {
  if (!value) return '<none>';
  const at = value.indexOf('@');
  if (at >= 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    return `${local.slice(0, 2)}***${domain}`;
  }
  return maskPhone(value);
}

export function loadNotificationDeliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationDeliveryConfig {
  const allowedRecipients = (env.NOTIFICATION_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((entry) => normalizeRecipient(entry))
    .filter((entry): entry is string => entry !== null);

  return {
    // Fail closed: only the exact string "true" enables delivery. An unset,
    // empty, misspelled or "1" value all mean blocked.
    enabled: env.NOTIFICATION_DELIVERY_ENABLED === 'true',
    // De-duplicated, but deliberately NOT deduped case-insensitively beyond the
    // normalization above — normalizeRecipient already case-folds emails.
    allowedRecipients: [...new Set(allowedRecipients)],
    policy: resolveRecipientPolicy(env),
  };
}

/**
 * The single place every outbound customer notification must pass before it can
 * reach an external provider.
 *
 * It sits in NotificationSenderWorker.sendRow, between the builder and the
 * provider factory, so ONE guard covers WhatsApp and Email alike and neither
 * provider carries recipient filtering of its own. Deliberately placed at
 * DELIVERY, not at generation: domain events still record NotificationOutbox
 * rows exactly as before, and only the outbound call is withheld.
 *
 * Conditions that must ALL hold before a send is permitted:
 *   1. NOTIFICATION_DELIVERY_ENABLED === 'true'
 *   2. the message carries a usable (normalizable) recipient for its channel
 *   3. under the default `allowlist` policy, that recipient appears in
 *      NOTIFICATION_ALLOWED_RECIPIENTS; under an explicit production `all`
 *      policy (B6) every legitimate customer recipient qualifies.
 *
 * Enabling delivery therefore never by itself means "send to everyone", and
 * there is no wildcard entry: an empty allowlist blocks everything.
 */
@Injectable()
export class NotificationDeliveryGate {
  private readonly logger = new Logger(NotificationDeliveryGate.name);

  constructor(
    @Inject(NOTIFICATION_DELIVERY_CONFIG) private readonly config: NotificationDeliveryConfig,
  ) {
    // Counts only — never the recipients themselves.
    this.logger.log(
      `notification delivery: enabled=${config.enabled} policy=${config.policy ?? 'allowlist'} allowlist_entries=${config.allowedRecipients.length}`,
    );
  }

  /** Throws NotificationBlockedError unless this exact message may be delivered. */
  assertDeliverable(message: NotificationMessage): void {
    if (!this.config.enabled) {
      throw new NotificationBlockedError('NOTIFICATION_DELIVERY_ENABLED is not "true"');
    }
    const allowlist = this.config.policy !== 'all';
    if (allowlist && this.config.allowedRecipients.length === 0) {
      throw new NotificationBlockedError('NOTIFICATION_ALLOWED_RECIPIENTS is empty');
    }

    const target = this.recipientFor(message);
    const normalized = normalizeRecipient(target);
    if (!normalized) {
      throw new NotificationBlockedError(
        `no usable recipient for channel ${message.channel} (${maskRecipient(target)})`,
      );
    }
    if (allowlist && !this.config.allowedRecipients.includes(normalized)) {
      throw new NotificationBlockedError(`recipient ${maskRecipient(normalized)} is not allowlisted`);
    }
  }

  /**
   * The address this message would actually be delivered to, chosen by the
   * message's own channel — the builder has already normalized it.
   */
  private recipientFor(message: NotificationMessage): string | null {
    return message.channel === NotificationChannel.EMAIL
      ? (message.recipient.email ?? null)
      : (message.recipient.phone ?? null);
  }
}
