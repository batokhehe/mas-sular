import { PaymentChannelCode } from './domain/payment-channel';
import {
  loadPaymentServiceFeeSettings,
  serviceFeeSettingFor,
  ServiceFeeSetting,
} from './domain/payment-channel-settings';

/**
 * Who bears the applicable Midtrans payment service fee.
 *
 * Deliberately INDEPENDENT of MIDTRANS_ENABLED: that switch decides whether the
 * gateway is available; these only decide whether the fee is added to the
 * customer's total (true) or absorbed by the merchant (false, the default).
 *
 *   PAYMENT_FEE_<channel>_ENABLED  per channel, when set;
 *   PAYMENT_SERVICE_FEE_ENABLED    the value every channel WITHOUT its own flag inherits.
 *
 * Only the exact string "true" enables pass-through; anything else is absorb.
 */
export const PAYMENT_SERVICE_FEE_CONFIG = 'PAYMENT_SERVICE_FEE_CONFIG';

export interface PaymentServiceFeeConfig {
  /** PAYMENT_SERVICE_FEE_ENABLED: the global default. */
  enabled: boolean;
  /** Explicit PAYMENT_FEE_<channel>_ENABLED values; absent channels inherit `enabled`. */
  channels?: Partial<Record<PaymentChannelCode, boolean>>;
}

export function loadPaymentServiceFeeConfig(env: NodeJS.ProcessEnv = process.env): PaymentServiceFeeConfig {
  const settings = loadPaymentServiceFeeSettings(env);
  return { enabled: settings.globalEnabled, channels: settings.channels };
}

/** The effective pass-through switch for one channel, and which variable decided it. */
export function feeSettingFor(config: PaymentServiceFeeConfig, channel: string | null | undefined): ServiceFeeSetting {
  return serviceFeeSettingFor({ globalEnabled: config.enabled, channels: config.channels ?? {} }, channel);
}
