import { PaymentChannelCode } from './payment-channel';
import { PAYMENT_SERVICE_FEE_RULES } from './payment-service-fee';

/**
 * Environment-controlled payment channel settings — PURE (no Nest, no I/O), shared by
 * env.validation (boot checks), the channel registry (availability) and the fee
 * calculation callers (pass-through). Read at boot: changing a value needs a backend
 * recreate.
 *
 * Two independent switches per channel:
 *   PAYMENT_<channel>_ENABLED      may a customer choose this channel for a NEW payment?
 *                                  Absent = enabled (the catalog's behavior before
 *                                  these variables existed).
 *   PAYMENT_FEE_<channel>_ENABLED  is the channel's service fee passed on to the
 *                                  customer? Absent = inherit PAYMENT_SERVICE_FEE_ENABLED
 *                                  (the single global switch before these existed).
 *
 * Only the exact strings "true" / "false" are accepted (env.validation rejects the rest).
 */

export interface PaymentChannelEnv {
  /** Availability switch. */
  availability: string;
  /** Service-fee pass-through switch. */
  fee: string;
}

/** Internal channel code -> its two variables. The ONLY place these names are spelled. */
export const PAYMENT_CHANNEL_ENV: Readonly<Record<PaymentChannelCode, PaymentChannelEnv>> = {
  MANUAL_TRANSFER: { availability: 'PAYMENT_TRANSFER_ENABLED', fee: 'PAYMENT_FEE_TRANSFER_ENABLED' },
  QRIS: { availability: 'PAYMENT_QRIS_ENABLED', fee: 'PAYMENT_FEE_QRIS_ENABLED' },
  GOPAY: { availability: 'PAYMENT_EWALLET_GOPAY_ENABLED', fee: 'PAYMENT_FEE_EWALLET_GOPAY_ENABLED' },
  SHOPEEPAY: { availability: 'PAYMENT_EWALLET_SHOPEEPAY_ENABLED', fee: 'PAYMENT_FEE_EWALLET_SHOPEEPAY_ENABLED' },
  BCA_VA: { availability: 'PAYMENT_VA_BCA_ENABLED', fee: 'PAYMENT_FEE_VA_BCA_ENABLED' },
  BNI_VA: { availability: 'PAYMENT_VA_BNI_ENABLED', fee: 'PAYMENT_FEE_VA_BNI_ENABLED' },
  BRI_VA: { availability: 'PAYMENT_VA_BRI_ENABLED', fee: 'PAYMENT_FEE_VA_BRI_ENABLED' },
  MANDIRI_BILL: { availability: 'PAYMENT_VA_MANDIRI_ENABLED', fee: 'PAYMENT_FEE_VA_MANDIRI_ENABLED' },
  PERMATA_VA: { availability: 'PAYMENT_VA_PERMATA_ENABLED', fee: 'PAYMENT_FEE_VA_PERMATA_ENABLED' },
  CREDIT_CARD: { availability: 'PAYMENT_CREDIT_CARD_ENABLED', fee: 'PAYMENT_FEE_CREDIT_CARD_ENABLED' },
};

/**
 * SeaBank VA has NO channel: no catalog entry, no Midtrans mapping, no fee rule. The
 * variables are recognised only so that turning either on fails boot loudly instead
 * of being silently ignored.
 */
export const SEABANK_VA_ENV: PaymentChannelEnv = {
  availability: 'PAYMENT_VA_SEABANK_ENABLED',
  fee: 'PAYMENT_FEE_VA_SEABANK_ENABLED',
};

/** Every variable, in a stable order (env schema, templates, tests). */
export const PAYMENT_CHANNEL_ENV_KEYS: readonly string[] = [
  ...Object.values(PAYMENT_CHANNEL_ENV).map((v) => v.availability),
  SEABANK_VA_ENV.availability,
  ...Object.values(PAYMENT_CHANNEL_ENV).map((v) => v.fee),
  SEABANK_VA_ENV.fee,
];

export const GLOBAL_SERVICE_FEE_ENV = 'PAYMENT_SERVICE_FEE_ENABLED';

const CHANNEL_CODES = Object.keys(PAYMENT_CHANNEL_ENV) as PaymentChannelCode[];

type Env = Record<string, string | undefined>;

/** "true" -> true, "false" -> false, absent/blank -> undefined (env.validation rejects anything else). */
function flag(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

// ------------------------------------------------------------ availability --

export interface PaymentChannelAvailabilityConfig {
  /** Resolved per channel: explicit flag, else true. */
  enabled: Readonly<Record<PaymentChannelCode, boolean>>;
}

export function loadPaymentChannelAvailability(env: Env = process.env): PaymentChannelAvailabilityConfig {
  const enabled = {} as Record<PaymentChannelCode, boolean>;
  for (const code of CHANNEL_CODES) enabled[code] = flag(env[PAYMENT_CHANNEL_ENV[code].availability]) ?? true;
  return { enabled };
}

export function isChannelEnabledByEnv(config: PaymentChannelAvailabilityConfig, code: string): boolean {
  return config.enabled[code as PaymentChannelCode] === true;
}

// ------------------------------------------------------------------- fees --

export type ServiceFeeSettingSource = 'CHANNEL' | 'GLOBAL';

/** Which switch decided pass-through for one channel, recorded with every fee snapshot. */
export interface ServiceFeeSetting {
  enabled: boolean;
  /** The variable that decided it (the channel's own, or PAYMENT_SERVICE_FEE_ENABLED). */
  variable: string;
  source: ServiceFeeSettingSource;
}

export interface PaymentServiceFeeSettings {
  /** PAYMENT_SERVICE_FEE_ENABLED === "true": the value channels without their own flag inherit. */
  globalEnabled: boolean;
  /** Explicit per-channel flags only; a channel absent here inherits the global value. */
  channels: Readonly<Partial<Record<PaymentChannelCode, boolean>>>;
}

export function loadPaymentServiceFeeSettings(env: Env = process.env): PaymentServiceFeeSettings {
  const channels: Partial<Record<PaymentChannelCode, boolean>> = {};
  for (const code of CHANNEL_CODES) {
    const value = flag(env[PAYMENT_CHANNEL_ENV[code].fee]);
    if (value !== undefined) channels[code] = value;
  }
  return { globalEnabled: env[GLOBAL_SERVICE_FEE_ENV] === 'true', channels };
}

/** The effective pass-through switch for a channel (null/unknown channel -> the global value). */
export function serviceFeeSettingFor(settings: PaymentServiceFeeSettings, channel: string | null | undefined): ServiceFeeSetting {
  const code = channel?.toUpperCase() as PaymentChannelCode | undefined;
  const own = code ? settings.channels[code] : undefined;
  if (code && own !== undefined) return { enabled: own, variable: PAYMENT_CHANNEL_ENV[code].fee, source: 'CHANNEL' };
  return { enabled: settings.globalEnabled, variable: GLOBAL_SERVICE_FEE_ENV, source: 'GLOBAL' };
}

// ------------------------------------------------------------ boot checks --

/**
 * Configuration errors that must stop boot, as [variable, message] pairs. Explicit
 * settings that cannot be honoured are refused rather than silently ignored.
 */
export function paymentChannelSettingIssues(env: Env): Array<[string, string]> {
  const issues: Array<[string, string]> = [];

  if (env[SEABANK_VA_ENV.availability] === 'true') {
    issues.push([SEABANK_VA_ENV.availability, `${SEABANK_VA_ENV.availability}=true: SeaBank VA is not implemented`]);
  }
  if (env[SEABANK_VA_ENV.fee] === 'true') {
    issues.push([SEABANK_VA_ENV.fee, `${SEABANK_VA_ENV.fee}=true: SeaBank VA is not implemented`]);
  }

  for (const code of CHANNEL_CODES) {
    const variable = PAYMENT_CHANNEL_ENV[code].fee;
    if (env[variable] !== 'true') continue;
    const rule = PAYMENT_SERVICE_FEE_RULES[code];
    if (!rule) {
      issues.push([variable, `${variable}=true: ${code} has no service fee rule, so there is no fee to pass on`]);
    } else if (rule.passThrough === 'PROHIBITED') {
      issues.push([variable, `${variable}=true: the ${code} service fee may never be charged to the customer (${rule.basis})`]);
    }
  }

  // Every gateway channel needs the gateway; manual transfer does not.
  const availability = loadPaymentChannelAvailability(env);
  const gatewayOn = env.MIDTRANS_ENABLED === 'true';
  const anyUsable = CHANNEL_CODES.some((code) => availability.enabled[code] && (code === 'MANUAL_TRANSFER' || gatewayOn));
  if (!anyUsable) {
    issues.push([
      PAYMENT_CHANNEL_ENV.MANUAL_TRANSFER.availability,
      gatewayOn
        ? 'Every payment channel is disabled: enable at least one PAYMENT_*_ENABLED channel'
        : 'Every payment channel is disabled: PAYMENT_TRANSFER_ENABLED=false and MIDTRANS_ENABLED is not true, so checkout would offer nothing',
    ]);
  }
  return issues;
}
