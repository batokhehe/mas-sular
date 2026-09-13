/** DI token for the Paxel webhook configuration. */
export const PAXEL_WEBHOOK_CONFIG = 'PAXEL_WEBHOOK_CONFIG';

export interface PaxelWebhookConfig {
  /**
   * PAXEL_WEBHOOK_ENABLED - only the exact string "true" opens the endpoint. It is
   * independent of PAXEL_ENABLED (quotes/booking/polling): receiving pushes changes
   * none of those, and the endpoint stays closed until an operator enables it.
   */
  enabled: boolean;
  /**
   * PAXEL_WEBHOOK_SECRET - the secret `X-Paxel-Signature` is verified with. Never
   * logged or returned. Required by env validation when the endpoint is enabled;
   * absent here the endpoint fails closed. Which secret Paxel signs webhooks with is
   * NEEDS PAXEL CONFIRMATION - it is deliberately not derived from PAXEL_API_SECRET.
   */
  secret?: string;
}

export function loadPaxelWebhookConfig(env: NodeJS.ProcessEnv = process.env): PaxelWebhookConfig {
  return { enabled: env.PAXEL_WEBHOOK_ENABLED === 'true', secret: env.PAXEL_WEBHOOK_SECRET?.trim() || undefined };
}
