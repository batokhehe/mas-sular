/**
 * PAXELBOX-61AG.3 — error taxonomy for address geocoding.
 *
 * Two classes, split by whether retrying could ever help — the same distinction
 * the shipping stack draws between PermanentError and TransientError:
 *
 *   GeocodingFailedError      the address cannot be geocoded, ever, as written
 *                             (ZERO_RESULTS, REQUEST_DENIED, a coordinate that
 *                             fails validation). Retrying is pointless.
 *   GeocodingUnavailableError Google could not answer right now (network,
 *                             timeout, 5xx, OVER_QUERY_LIMIT, UNKNOWN_ERROR).
 *                             The same address may succeed later.
 *
 * Neither carries the request URL: Google takes the API key as a QUERY
 * PARAMETER, so the URL is secret-bearing and must never reach a message, a log
 * line or an HTTP response.
 */
export class GeocodingError extends Error {
  constructor(
    message: string,
    /** Google's own `status`, or a short internal reason. Never a URL, never a key. */
    readonly reason: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The address cannot be resolved as written. Not retryable. */
export class GeocodingFailedError extends GeocodingError {}

/** Google was unreachable or refused to answer right now. Retryable. */
export class GeocodingUnavailableError extends GeocodingError {}
