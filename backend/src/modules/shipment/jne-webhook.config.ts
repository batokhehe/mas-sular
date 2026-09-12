/** DI token for the JNE Webhook Status V2 configuration. */
export const JNE_WEBHOOK_CONFIG = 'JNE_WEBHOOK_CONFIG';

export interface JneWebhookConfig {
  /**
   * JNE_WEBHOOK_ENABLED - only the exact string "true" opens the endpoint. It is
   * independent of JNE_ENABLED (booking/tracking credentials): receiving pushes needs
   * no JNE credential, and JNE's V2 documentation specifies no webhook
   * authentication, so the endpoint stays closed until an operator enables it.
   */
  enabled: boolean;
}

export function loadJneWebhookConfig(env: NodeJS.ProcessEnv = process.env): JneWebhookConfig {
  return { enabled: env.JNE_WEBHOOK_ENABLED === 'true' };
}
