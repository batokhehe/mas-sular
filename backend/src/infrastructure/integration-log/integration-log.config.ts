import { intOr, positiveInt } from '../../common/utils/number.util';
import { DEFAULT_SANITIZE_OPTIONS, SanitizeOptions } from './integration-log.sanitizer';

export const INTEGRATION_LOG_CONFIG = 'INTEGRATION_LOG_CONFIG';

export interface IntegrationLogConfig {
  /** Master switch for persisting IntegrationApiLog rows. Default on. */
  enabled: boolean;
  /** Payload caps handed to the sanitizer. */
  sanitize: SanitizeOptions;
}

export function loadIntegrationLogConfig(env: NodeJS.ProcessEnv = process.env): IntegrationLogConfig {
  return {
    enabled: (env.INTEGRATION_LOG_ENABLED ?? 'true') !== 'false',
    sanitize: {
      maxBytes: positiveInt(env.INTEGRATION_LOG_MAX_BYTES, DEFAULT_SANITIZE_OPTIONS.maxBytes),
      maxStringLength: positiveInt(env.INTEGRATION_LOG_MAX_STRING, DEFAULT_SANITIZE_OPTIONS.maxStringLength),
      maxDepth: positiveInt(env.INTEGRATION_LOG_MAX_DEPTH, DEFAULT_SANITIZE_OPTIONS.maxDepth),
      maxArrayItems: intOr(env.INTEGRATION_LOG_MAX_ARRAY_ITEMS, DEFAULT_SANITIZE_OPTIONS.maxArrayItems),
    },
  };
}
