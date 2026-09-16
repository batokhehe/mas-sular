import { IntegrationLogEntry, IntegrationRecorder } from './integration-log.types';

/**
 * The ONE way anything hands an entry to the integration-log recorder.
 *
 * Integration logging is best-effort, always: a provider call, a webhook or a
 * checkout must behave identically whether the record was written, silently
 * dropped, or blew up on the way out. `IntegrationLogService` already swallows its
 * own failures; this wrapper is the guarantee that holds even when the injected
 * recorder is a different implementation, a half-constructed double, or throws
 * synchronously before its own try/catch can run.
 *
 * Both failure modes are contained:
 *   - a synchronous throw is caught here;
 *   - a recorder that (against the void contract) returns a rejected promise has
 *     its rejection attached to a catch, so it can never become an unhandled one.
 *
 * `onError` is a REPORTING hook only - it is called inside the catch, and anything
 * it throws is ignored too. Nothing here ever rethrows.
 */
export function safeRecord(
  recorder: IntegrationRecorder | undefined,
  entry: IntegrationLogEntry,
  onError?: (err: unknown) => void,
): void {
  if (!recorder) return;
  try {
    const result = recorder.record(entry) as unknown;
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch((err) => report(onError, err));
    }
  } catch (err) {
    report(onError, err);
  }
}

/** A failing reporter must not defeat the guarantee it exists to describe. */
function report(onError: ((err: unknown) => void) | undefined, err: unknown): void {
  try {
    onError?.(err);
  } catch {
    // Deliberately empty: logging about failed logging is never worth an exception.
  }
}
