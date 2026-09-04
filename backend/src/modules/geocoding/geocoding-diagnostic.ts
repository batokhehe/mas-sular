/**
 * PAXELBOX-61AG.3.8.3 — credential-safe diagnostic text from a Google Geocoding
 * response.
 *
 * Why this exists: when Google refuses a request it answers with a status token
 * (`REQUEST_DENIED`) plus an `error_message` that says WHICH of several unrelated
 * causes applied — billing not enabled, the API not enabled on the project, an
 * invalid or restricted key. The token alone cannot distinguish them, and
 * discarding the message cost two full diagnostic phases (61AG.3.1, 61AG.3.2) to
 * work around.
 *
 * The message is therefore surfaced to the LOG ONLY. It never reaches the thrown
 * error, the HTTP response, or any customer-facing surface — `GeocodingService`
 * still throws exactly the message it threw before.
 *
 * Follows the shape of common/diagnostics/amqp-redact.ts: scrub defensively even
 * though the provider is not expected to echo anything sensitive.
 */

/** Diagnostic text is a log field, not a payload — keep it short. */
const MAX_LENGTH = 200;

/**
 * Google's `error_message`, made safe to log.
 *
 * Returns undefined when there is nothing useful to say, so the caller can omit
 * the field entirely rather than logging an empty one.
 */
export function redactGeocodingDiagnostic(raw: unknown, apiKey?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let scrubbed = trimmed;

  // 1. The configured key, verbatim. Google is not expected to echo it, but this
  //    is the one value that must never reach a log line under any circumstance.
  if (apiKey && apiKey.length > 0) {
    scrubbed = scrubbed.split(apiKey).join('[REDACTED_KEY]');
  }

  // 2. Anything shaped like a key parameter, whatever its value — covers a
  //    rotated key, a second key, or a message that quotes the query string.
  scrubbed = scrubbed.replace(/\bkey=[^\s&"']+/gi, 'key=[REDACTED]');

  // 3. URLs are dropped wholesale: the request URL is secret-bearing by
  //    construction, so no URL from this provider is worth logging.
  scrubbed = scrubbed.replace(/https?:\/\/\S+/gi, '[url]');

  return scrubbed.length > MAX_LENGTH ? scrubbed.slice(0, MAX_LENGTH) + '…' : scrubbed;
}
