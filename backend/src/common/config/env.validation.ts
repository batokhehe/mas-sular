import { PAYMENT_CHANNEL_ENV_KEYS, paymentChannelSettingIssues } from '../../modules/payments/gateway/domain/payment-channel-settings';
import { z } from 'zod';
import {
  isJneSandboxUrl,
  isValidTimeZone,
  JNE_PICKUP_ENV,
  JNE_PICKUP_SERVICES,
  JNE_PICKUP_TYPES,
  JNE_PICKUP_VEHICLES,
} from '../../modules/shipping/shipping.config';
import { TRUST_PROXY_MAX_HOPS } from '../http/trust-proxy';
import { jneWebhookSourceIpIssue } from '../../modules/shipment/jne-webhook.config';
import { ADMIN_ACCESS_TTL_MAX_MS, adminAccessTtlToMs } from '../../modules/admin-auth/admin-session.config';

/** Known hardcoded development secrets that must never be used as real secrets. */
const INSECURE_SECRETS = new Set(['development-only-secret', 'development-only-admin-secret']);

const HOUR_MS = 60 * 60 * 1000;

/** A value copied from production.env.example and never filled in. */
const UNFILLED_PLACEHOLDER = /CHANGE_ME|<[A-Z][A-Z0-9_]*>/;

const boolFlag = z.enum(['true', 'false']).default('false');

/**
 * An empty / whitespace-only value means UNSET. Used for the JNE `/pickupcashless`
 * keys, whose template placeholders are deliberately empty (`JNE_PICKUP_NAME=`):
 * without this an empty enum placeholder would fail boot even with JNE disabled.
 * Required-ness is enforced separately, only when JNE_ENABLED=true.
 */
const blankAsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalText = z.preprocess(blankAsUnset, z.string().optional());

const secret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .refine((v) => !INSECURE_SECRETS.has(v), 'must not be a known insecure development secret');

const baseSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().optional(),

    // Core infrastructure (always required)
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // Auth secrets — no hardcoded fallbacks; min length enforced in every environment.
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    JWT_ADMIN_ACCESS_SECRET: secret,
    // H4: admin access tokens live for hours, never days (no admin refresh token).
    JWT_ADMIN_ACCESS_TTL: z
      .string()
      .optional()
      .refine((v) => v === undefined || v.trim() === '' || adminAccessTtlToMs(v) !== null, {
        message: `must be <n>s|<n>m|<n>h and at most ${ADMIN_ACCESS_TTL_MAX_MS / 3_600_000}h (days are not allowed)`,
      }),
    // M4: domain of the httpOnly admin cookie. Unset (recommended) = host-only on the API host.
    ADMIN_COOKIE_DOMAIN: z.string().optional(),
    // M1: optional bearer token for scraping /metrics through the proxy. Unset = direct in-network scrapes only.
    METRICS_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
    GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),

    // Upload URLs
    APP_URL: z.string().url('APP_URL must be a valid URL'),
    PAYMENT_UPLOAD_BASE_URL: z.string().url('PAYMENT_UPLOAD_BASE_URL must be a valid URL').optional(),

    // CORS — validated cross-field below (required in non-local, no wildcard)
    CORS_ORIGINS: z.string().optional(),

    // B3: reverse-proxy hops in front of the API (a hop COUNT, never "trust all").
    // Required outside local (cross-field below); see common/http/trust-proxy.ts.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(TRUST_PROXY_MAX_HOPS).optional(),

    // Async pipeline toggles + their conditionally-required settings
    OUTBOX_RELAY_ENABLED: boolFlag,
    CONSUMERS_ENABLED: boolFlag,
    RABBITMQ_URL: z.string().optional(),

    NOTIFICATION_SENDER_ENABLED: boolFlag,
    // B6: who may receive a delivered notification. `allowlist` (default) or `all`;
    // `all` is production-only (cross-field below). See notification-delivery.gate.ts.
    NOTIFICATION_RECIPIENT_POLICY: z.enum(['allowlist', 'all']).optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    ADMIN_NOTIFICATION_EMAIL: z.string().email('ADMIN_NOTIFICATION_EMAIL must be a valid email').optional(),

    // Payment lifecycle windows — ordering validated cross-field below
    PAYMENT_LIFECYCLE_ENABLED: boolFlag,
    PAYMENT_FIRST_REMINDER_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_SECOND_REMINDER_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_EXPIRY_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_GATEWAY_EXPIRY_MS: z.coerce.number().int().nonnegative().optional(),

    // Midtrans payment gateway (Phase 3). All optional: with MIDTRANS_ENABLED
    // unset/false the provider is not registered and no key is required. The
    // enabled+serverKey pairing is enforced by assertMidtransConfigured() at boot.
    MIDTRANS_ENABLED: boolFlag,
    MIDTRANS_SERVER_KEY: z.string().optional(),
    MIDTRANS_CLIENT_KEY: z.string().optional(),
    MIDTRANS_IS_PRODUCTION: boolFlag,
    MIDTRANS_BASE_URL: z.string().url('MIDTRANS_BASE_URL must be a valid URL').optional(),
    MIDTRANS_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    MIDTRANS_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),
    // Who bears the applicable gateway fee: "true" = added to the customer's total,
    // "false" (default) = absorbed by the merchant. Independent of MIDTRANS_ENABLED;
    // QRIS and cards never pass the fee on (payment-service-fee.ts).
    PAYMENT_SERVICE_FEE_ENABLED: boolFlag,
    // Per-channel availability (absent = enabled) and fee pass-through (absent = inherit
    // PAYMENT_SERVICE_FEE_ENABLED): only "true" / "false". See payment-channel-settings.ts.
    ...Object.fromEntries(PAYMENT_CHANNEL_ENV_KEYS.map((key) => [key, z.enum(['true', 'false']).optional()])),

    // Phase 13A — httpOnly auth cookies. All optional; cookie behavior is env-driven.
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
    // Phase 13A.4 — gates the JWT cookie extractors. Default false → behavior is
    // identical to pre-13A.4 production (Bearer-only). Flip to true to accept cookies.
    AUTH_COOKIE_EXTRACTOR_ENABLED: boolFlag,
    // Stateless double-submit CSRF. report → log-only, off → no validation.
    //
    // Defaults to ENFORCE (61AG.3.26). It shipped defaulting to `off` for the
    // 13A.6 rollout, which left every cookie-authenticated mutation forgeable
    // unless an operator opted in — a security control that is off by default is
    // a control the deployment does not have. Only cookie-authenticated unsafe
    // methods are affected: Bearer clients, webhooks and safe methods bypass.
    //
    // Rolling this onto an EXISTING deployment: run `report` first and watch for
    // "[CSRF report] would block", which surfaces any client not yet sending
    // X-CSRF-Token, then switch to enforce.
    CSRF_MODE: z.enum(['off', 'report', 'enforce']).default('enforce'),

    // WhatsApp (Mekari Qontak) notifications. Required (cross-field below) only when
    // the sender is enabled and the provider routes WhatsApp. No bank data in env.
    NOTIFICATION_PROVIDER: z.enum(['multi', 'email', 'qontak']).default('multi'),
    QONTAK_API_TOKEN: z.string().optional(),
    QONTAK_CHANNEL_INTEGRATION_ID: z.string().optional(),
    QONTAK_ORDER_TEMPLATE_ID: z.string().optional(),
    QONTAK_COD_TEMPLATE_ID: z.string().optional(),
    QONTAK_BASE_URL: z.string().url('QONTAK_BASE_URL must be a valid URL').optional(),
    QONTAK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    QONTAK_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),

    // Shipping providers (Paxel / JNE). Disabled by default; credentials are
    // required (cross-field below) only when the provider is enabled.
    SHIPPING_ORIGIN_POSTAL_CODE: z.string().optional(),
    PAXEL_ENABLED: boolFlag,
    PAXEL_BASE_URL: z.string().optional(),
    PAXEL_API_KEY: z.string().optional(),
    // Signs X-Paxel-Signature on create/cancel. Required when Paxel is enabled.
    PAXEL_API_SECRET: z.string().optional(),
    // Merchant pickup contact sent as origin.phone (Paxel: 9-13 digits).
    PAXEL_ORIGIN_PHONE: z.string().regex(/^\d{9,13}$/, 'PAXEL_ORIGIN_PHONE must be 9-13 digits').optional(),
    // Pickup instruction for the courier, sent as origin.note. No default: it is
    // a real instruction and a placeholder would be shipped as if it were true.
    PAXEL_ORIGIN_NOTE: z.string().min(1).optional(),
    // Paxel's need_insurance. Absent or anything but 'true' means OFF.
    PAXEL_NEED_INSURANCE: boolFlag,
    PAXEL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    PAXEL_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),
    // Parcel envelope for Paxel's required `dimension` (LxWxH cm, each side 1-50).
    // Paxel prices from it, so a bad value silently changes what customers pay.
    PAXEL_DEFAULT_DIMENSION: z.string().regex(/^\d{1,2}x\d{1,2}x\d{1,2}$/, 'PAXEL_DEFAULT_DIMENSION must be LxWxH in cm, e.g. 30x35x20').optional(),
    // Courier pickup rule (PAXELBOX-61AG.3.32, P1 #13). PAXEL_AUTO_PICKUP_ENABLED
    // is Paxel's own booking switch: absent or anything but 'true' means OFF, so a
    // courier is never booked automatically by an unset variable. The three times
    // are OPTIONAL overrides of the shop-wide rule in shipping.config.ts
    // (DEFAULT_PICKUP_POLICY: cut-off 15:00, pickup 17:00, Asia/Jakarta), which
    // applies to every courier; they are only validated when set.
    PAXEL_AUTO_PICKUP_ENABLED: boolFlag,
    PAXEL_PICKUP_TIMEZONE: z.string().optional(),
    // The latest payment VERIFICATION time still eligible for today's pickup -
    // not the latest pickup time. With the business rule the pickup itself is
    // deliberately later than this.
    PAXEL_PICKUP_CUTOFF_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'PAXEL_PICKUP_CUTOFF_TIME must be HH:mm (24-hour), e.g. 15:00')
      .optional(),
    PAXEL_PICKUP_DEFAULT_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'PAXEL_PICKUP_DEFAULT_TIME must be HH:mm (24-hour), e.g. 17:00')
      .optional(),
    // Server-side address geocoding (PAXELBOX-61AG.3). OFF by default: enabling
    // it makes address creation depend on Google, and a failure must surface
    // rather than persist a placeholder coordinate.
    GEOCODING_ENABLED: boolFlag,
    // Server-side ONLY. Never NEXT_PUBLIC_*, which Next compiles into the browser bundle.
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    GOOGLE_GEOCODING_BASE_URL: z.string().optional(),
    GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    JNE_ENABLED: boolFlag,
    // Which JNE tenant the courier addresses. Absent means sandbox; an
    // unrecognised value is rejected here rather than silently downgraded.
    JNE_ENVIRONMENT: z.enum(['sandbox', 'production']).optional(),
    JNE_BASE_URL: z.string().optional(),
    JNE_API_KEY: z.string().optional(),
    JNE_USERNAME: z.string().optional(),
    JNE_ORIGIN_CODE: z.string().optional(),
    JNE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    JNE_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),
    // JNE /pickupcashless merchant & pickup master data (required when JNE_ENABLED=true,
    // cross-field below). Enums are the documented values, case-sensitive.
    JNE_PICKUP_NAME: optionalText,
    JNE_PICKUP_PIC: optionalText,
    JNE_PICKUP_PIC_PHONE: optionalText,
    JNE_PICKUP_ADDRESS: optionalText,
    JNE_PICKUP_DISTRICT: optionalText,
    JNE_PICKUP_CITY: optionalText,
    JNE_PICKUP_SERVICE: z.preprocess(blankAsUnset, z.enum(JNE_PICKUP_SERVICES).optional()),
    JNE_PICKUP_VEHICLE: z.preprocess(blankAsUnset, z.enum(JNE_PICKUP_VEHICLES).optional()),
    JNE_BRANCH: optionalText,
    JNE_CUST_ID: optionalText,
    JNE_MERCHANT_ID: optionalText,
    JNE_SHIPPER_NAME: optionalText,
    JNE_SHIPPER_ADDR1: optionalText,
    JNE_SHIPPER_ADDR2: optionalText,
    JNE_SHIPPER_CITY: optionalText,
    JNE_SHIPPER_ZIP: optionalText,
    JNE_SHIPPER_REGION: optionalText,
    JNE_SHIPPER_CONTACT: optionalText,
    JNE_SHIPPER_PHONE: optionalText,
    JNE_TYPE: z.preprocess(blankAsUnset, z.enum(JNE_PICKUP_TYPES).optional()),
    // Inbound JNE Webhook Status V2. OFF by default: JNE's V2 documentation defines no
    // webhook authentication, so the endpoint is only reachable once deliberately enabled.
    JNE_WEBHOOK_ENABLED: boolFlag,
    // Extra webhook source IPs (comma-separated). Outside JNE_ENVIRONMENT=production only;
    // the JNE-confirmed address is always allowed. See jne-webhook.config.ts.
    JNE_WEBHOOK_EXTRA_SOURCE_IPS: z.string().optional(),
    // Inbound Paxel webhook. OFF by default and independent of PAXEL_ENABLED. When on,
    // X-Paxel-Signature is verified with PAXEL_WEBHOOK_SECRET (required, cross-field
    // below). Which secret Paxel signs with is not yet confirmed by Paxel.
    PAXEL_WEBHOOK_ENABLED: boolFlag,
    PAXEL_WEBHOOK_SECRET: z.string().optional(),

    // Checkout idempotency. Optional locally; MUST be true in staging/production
    // (cross-field below) so duplicate checkout requests can never double-create.
    CHECKOUT_IDEMPOTENCY_ENABLED: boolFlag,

    // Manual BANK_TRANSFER unique code. Disabled by default → behavior identical to
    // before. Range invariants (min >= 0, max <= 999, max > min) checked cross-field.
    PAYMENT_UNIQUE_CODE_ENABLED: boolFlag,
    PAYMENT_UNIQUE_CODE_MIN: z.coerce.number().int().optional(),
    PAYMENT_UNIQUE_CODE_MAX: z.coerce.number().int().optional(),

    // Enterprise logging center (additive). All optional; persistence + retention
    // default on with a 90-day window.
    SYSTEM_LOG_ENABLED: boolFlag.optional(),
    SYSTEM_LOG_RETENTION_ENABLED: boolFlag.optional(),
    LOG_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  })
  .passthrough(); // tolerate the many optional tuning vars (OUTBOX_*, NOTIFICATION_SENDER_*, RETENTION_*, ...)

export const envSchema = baseSchema.superRefine((env, ctx) => {
  const isLocal = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  // CORS: explicit allowlist only; required outside local; no reflect-all wildcard.
  const corsList = (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!isLocal && corsList.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'CORS_ORIGINS must list at least one explicit origin in staging/production' });
  }
  if (corsList.includes('*')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'wildcard "*" origin is not allowed with credentialed CORS' });
  }

  // B4: production.env.example uses CHANGE_ME secrets and <PLACEHOLDER> values that
  // are deliberately unbootable - several placeholder secrets are long enough to pass
  // the 32-char rule, so without this a forgotten one would run on a public value.
  if (!isLocal) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === 'string' && UNFILLED_PLACEHOLDER.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} still holds a template placeholder (CHANGE_ME / <...>)` });
      }
    }
  }

  // B3: outside local the API runs behind a reverse proxy, and an unset hop count
  // silently collapses every visitor into the proxy's rate-limit bucket. Explicit.
  if (!isLocal && env.TRUST_PROXY_HOPS === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUST_PROXY_HOPS'],
      message: 'TRUST_PROXY_HOPS must be set in staging/production (1 for a single reverse proxy in front of the API)',
    });
  }

  // M5: checkout idempotency must be enabled outside local (staging/production), so a
  // duplicate/retried checkout can never create duplicate orders/payments/reservations.
  // Development and test may disable it; staging follows production.
  if (!isLocal && env.CHECKOUT_IDEMPOTENCY_ENABLED !== 'true') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CHECKOUT_IDEMPOTENCY_ENABLED'],
      message: 'CHECKOUT_IDEMPOTENCY_ENABLED must be "true" in staging/production',
    });
  }

  // B6: sending to every customer is a deliberate production decision. Development,
  // test and staging stay on the allowlist so a local or staging stack can never
  // message real customers.
  if (env.NOTIFICATION_RECIPIENT_POLICY === 'all' && env.NODE_ENV !== 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NOTIFICATION_RECIPIENT_POLICY'],
      message: 'NOTIFICATION_RECIPIENT_POLICY=all is only allowed with NODE_ENV=production; use allowlist elsewhere',
    });
  }

  // RabbitMQ required whenever the relay or consumers are enabled.
  if ((env.OUTBOX_RELAY_ENABLED === 'true' || env.CONSUMERS_ENABLED === 'true') && !env.RABBITMQ_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RABBITMQ_URL'], message: 'RABBITMQ_URL is required when OUTBOX_RELAY_ENABLED or CONSUMERS_ENABLED is true' });
  }

  // Resend credentials required when the sender is enabled.
  if (env.NOTIFICATION_SENDER_ENABLED === 'true') {
    if (!env.RESEND_API_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required when NOTIFICATION_SENDER_ENABLED=true' });
    if (!env.EMAIL_FROM) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_FROM'], message: 'EMAIL_FROM is required when NOTIFICATION_SENDER_ENABLED=true' });

    // Qontak credentials required when WhatsApp is routable (provider multi|qontak).
    const provider = (env.NOTIFICATION_PROVIDER as string | undefined) ?? 'multi';
    if (provider !== 'email') {
      for (const key of ['QONTAK_API_TOKEN', 'QONTAK_CHANNEL_INTEGRATION_ID', 'QONTAK_ORDER_TEMPLATE_ID', 'QONTAK_COD_TEMPLATE_ID'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when NOTIFICATION_SENDER_ENABLED=true and NOTIFICATION_PROVIDER=${provider}` });
        }
      }
    }
  }

  // Shipping providers: credentials are required when the provider is enabled.
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_API_KEY'], message: 'PAXEL_API_KEY is required when PAXEL_ENABLED=true' });
  }
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_API_SECRET) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_API_SECRET'], message: 'PAXEL_API_SECRET is required when PAXEL_ENABLED=true' });
  }
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_ORIGIN_PHONE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_ORIGIN_PHONE'], message: 'PAXEL_ORIGIN_PHONE is required when PAXEL_ENABLED=true' });
  }
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_ORIGIN_NOTE?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_ORIGIN_NOTE'], message: 'PAXEL_ORIGIN_NOTE is required when PAXEL_ENABLED=true' });
  }
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_DEFAULT_DIMENSION) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_DEFAULT_DIMENSION'], message: 'PAXEL_DEFAULT_DIMENSION is required when PAXEL_ENABLED=true' });
  }
  // Pickup rule overrides: none is required (unset means the shop-wide default,
  // cut-off 15:00 / pickup 17:00 Asia/Jakarta), but one that IS set must be valid
  // - and regardless of PAXEL_AUTO_PICKUP_ENABLED, because JNE records the same
  // slot either way. The HH:mm format of the two times is checked by their own
  // schemas above; the timezone needs ICU, so it is checked here.
  // The Paxel webhook fails closed without a verification secret; refuse to boot
  // with it enabled and nothing to verify against.
  if (env.PAXEL_WEBHOOK_ENABLED === 'true' && !env.PAXEL_WEBHOOK_SECRET?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_WEBHOOK_SECRET'], message: 'PAXEL_WEBHOOK_SECRET is required when PAXEL_WEBHOOK_ENABLED=true' });
  }
  if (env.PAXEL_PICKUP_TIMEZONE?.trim() && !isValidTimeZone(env.PAXEL_PICKUP_TIMEZONE)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_PICKUP_TIMEZONE'], message: `PAXEL_PICKUP_TIMEZONE is not a valid IANA timezone ('${env.PAXEL_PICKUP_TIMEZONE}')` });
  }
  // JNE webhook source addresses: production trusts only JNE-confirmed IPs.
  const jneSourceIpIssue = jneWebhookSourceIpIssue(env as NodeJS.ProcessEnv);
  if (jneSourceIpIssue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JNE_WEBHOOK_EXTRA_SOURCE_IPS'], message: jneSourceIpIssue });
  }

  if (env.JNE_ENABLED === 'true') {
    for (const key of ['JNE_API_KEY', 'JNE_USERNAME', 'JNE_ORIGIN_CODE'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when JNE_ENABLED=true` });
      }
    }
    // JNE /pickupcashless master data: no defaults exist for any of it, so an enabled
    // courier without it must not boot (the booking would otherwise fail per order).
    for (const key of Object.values(JNE_PICKUP_ENV)) {
      if (!(env as Record<string, unknown>)[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when JNE_ENABLED=true` });
      }
    }
    // PAXELBOX-61K. JNE tracking and cancel spend JNE_BASE_URL on real cnotes, so a
    // production courier may neither borrow the sandbox nor inherit a default: JNE
    // has supplied no production endpoint, so production must name its own.
    if (env.JNE_ENVIRONMENT === 'production') {
      if (!env.JNE_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JNE_BASE_URL'],
          message: 'JNE production configuration is incomplete: JNE_BASE_URL is required when JNE_ENVIRONMENT=production',
        });
      } else if (isJneSandboxUrl(env.JNE_BASE_URL)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JNE_BASE_URL'],
          message: 'JNE is enabled in production but JNE_BASE_URL points to the known sandbox endpoint',
        });
      }
    }
  }

  // Payment channels / per-channel service fee: explicit settings that cannot be
  // honoured (SeaBank, a prohibited or rule-less fee pass-through, nothing to pay
  // with) stop boot instead of being silently ignored.
  for (const [key, message] of paymentChannelSettingIssues(env as Record<string, string | undefined>)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
  }

  // Geocoding needs a key the moment it is switched on; discovering that at the
  // first customer address instead of at boot would fail a real checkout.
  if (env.GEOCODING_ENABLED === 'true' && !env.GOOGLE_MAPS_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GOOGLE_MAPS_API_KEY'], message: 'GOOGLE_MAPS_API_KEY is required when GEOCODING_ENABLED=true' });
  }

  // Browsers reject SameSite=None cookies unless they are also Secure.
  if (env.COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE !== 'true') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be "true" when COOKIE_SAMESITE=none' });
  }

  // Unique-code range invariants (only meaningful when the feature is enabled, but
  // validated whenever provided so a bad range never reaches the generator).
  const codeMin = env.PAYMENT_UNIQUE_CODE_MIN ?? 100;
  const codeMax = env.PAYMENT_UNIQUE_CODE_MAX ?? 999;
  if (codeMin < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MIN'], message: 'PAYMENT_UNIQUE_CODE_MIN must be >= 0' });
  }
  if (codeMax > 999) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MAX'], message: 'PAYMENT_UNIQUE_CODE_MAX must be <= 999' });
  }
  if (!(codeMax > codeMin)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MAX'], message: 'PAYMENT_UNIQUE_CODE_MAX must be greater than PAYMENT_UNIQUE_CODE_MIN' });
  }

  // Payment timing must be strictly increasing so reminders precede expiry.
  // Defaults mirror payment-lifecycle.config (12h / 20h / 24h).
  const first = env.PAYMENT_FIRST_REMINDER_MS ?? 12 * HOUR_MS;
  const second = env.PAYMENT_SECOND_REMINDER_MS ?? 20 * HOUR_MS;
  const expiry = env.PAYMENT_EXPIRY_MS ?? 24 * HOUR_MS;
  if (!(first < second && second < expiry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_EXPIRY_MS'],
      message: `payment windows must satisfy FIRST_REMINDER (${first}) < SECOND_REMINDER (${second}) < EXPIRY (${expiry}) ms`,
    });
  }
});

/**
 * ConfigModule `validate` hook. Throws a single aggregated error (fail-fast) when
 * any environment variable is missing/invalid, so the app never boots in a
 * dangerous configuration.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => ` - ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
