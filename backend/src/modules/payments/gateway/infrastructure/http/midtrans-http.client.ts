import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IntegrationDirection, IntegrationOutcome } from '@prisma/client';
import { PermanentGatewayError, TransientGatewayError } from '../../domain/payment-gateway-errors';
import { safeRecord } from '../../../../../infrastructure/integration-log/safe-record';
import { IntegrationCallContext } from '../../../../../infrastructure/integration-log/integration-log.types';

/** Exactly the HTTP statuses worth repeating — everything else is a decision, not a glitch. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface MidtransHttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface MidtransHttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type MidtransHttpClient = (url: string, init: MidtransHttpRequest) => Promise<MidtransHttpResponse>;

/** Real transport: fetch + AbortController timeout. Swapped for a stub in tests. */
export const defaultMidtransHttpClient: MidtransHttpClient = async (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const controller = new g.AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await g.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

export interface MidtransRequestOptions {
  http: MidtransHttpClient;
  url: string;
  init: MidtransHttpRequest;
  maxRetry: number;
  logger: Logger;
  /** Secret-free correlation fields for the structured log. */
  logBase: Record<string, unknown>;
  /**
   * OPTIONAL business context for durable integration logging (P1). Absent, this
   * function behaves exactly as before - existing unit tests pass no such field.
   */
  integration?: IntegrationCallContext;
}

/** Case-insensitive header lookup for the sanitizer (Midtrans sends JSON). */
function contentTypeOf(init: MidtransHttpRequest): string | undefined {
  const entry = Object.entries(init.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type');
  return entry?.[1];
}

function sanitize(text: string): string {
  return text.slice(0, 300);
}

/**
 * Execute a Midtrans request with timeout, bounded retry, and error
 * classification. Returns the parsed JSON body on success.
 *
 * Retries are safe because every call carries a stable `X-Idempotency-Key` AND a
 * per-attempt `order_id`: Midtrans rejects a duplicate order_id outright (406),
 * so a repeated charge can never double-bill. Logs deliberately carry no keys,
 * card data, or customer PII.
 */
export async function executeMidtransRequest<T>(opts: MidtransRequestOptions): Promise<T> {
  const { http, url, init, maxRetry, logger, logBase, integration } = opts;
  const attempts = Math.max(1, maxRetry + 1);
  const startedAt = Date.now();
  let lastTransient: TransientGatewayError | undefined;
  const operationId = integration ? (integration.operationId ?? randomUUID()) : '';

  /** Best-effort: handed to the shared safeRecord(), which can never throw or reject. */
  const record = (fields: {
    attempt: number;
    durationMs: number;
    httpStatus?: number | null;
    outcome: IntegrationOutcome;
    errorClass?: string | null;
    errorMessage?: string | null;
    responseBody?: string | null;
  }): void => {
    if (!integration?.recorder) return;
    safeRecord(
      integration.recorder,
      {
        provider: integration.provider,
        operation: integration.operation,
        direction: IntegrationDirection.OUTBOUND,
        operationId,
        attempt: fields.attempt,
        maxAttempts: attempts,
        correlationId: integration.correlationId ?? null,
        orderId: integration.orderId ?? null,
        paymentId: integration.paymentId ?? null,
        shipmentId: integration.shipmentId ?? null,
        method: init.method,
        endpoint: url,
        httpStatus: fields.httpStatus ?? null,
        durationMs: fields.durationMs,
        applicationOutcome: fields.outcome,
        errorClass: fields.errorClass ?? null,
        errorMessage: fields.errorMessage ?? null,
        requestBody: init.body ?? null,
        requestContentType: contentTypeOf(init),
        responseBody: fields.responseBody ?? null,
      },
      (err) => logger.warn({ event: 'integration_log.record_failed', reason: err instanceof Error ? err.message : String(err) }),
    );
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    let res: MidtransHttpResponse;
    try {
      res = await http(url, init);
    } catch (err) {
      // AbortError (timeout) and network failures land here — retryable.
      const reason = err instanceof Error ? err.message : String(err);
      lastTransient = new TransientGatewayError(`network error: ${reason}`, 'midtrans');
      logger.warn({ ...logBase, attempt, outcome: 'retry', errorClass: 'network', elapsedMs: Date.now() - startedAt });
      const timedOut = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
      record({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        outcome: timedOut ? IntegrationOutcome.TIMEOUT : IntegrationOutcome.NETWORK_ERROR,
        errorClass: timedOut ? 'timeout' : 'network',
        errorMessage: reason,
      });
      continue;
    }

    const text = await res.text().catch(() => '');

    if (res.status >= 200 && res.status < 300) {
      logger.log({ ...logBase, attempt, outcome: 'ok', status: res.status, elapsedMs: Date.now() - startedAt });
      // A 2xx whose body is not JSON is an APPLICATION failure, not a transport one:
      // the record says PARSE_FAILED and keeps the body that could not be parsed.
      try {
        const parsed = parseJson<T>(text);
        record({ attempt, durationMs: Date.now() - attemptStartedAt, httpStatus: res.status, outcome: IntegrationOutcome.OK, responseBody: text });
        return parsed;
      } catch (err) {
        record({
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          httpStatus: res.status,
          outcome: IntegrationOutcome.PARSE_FAILED,
          errorClass: 'parse_failed',
          errorMessage: err instanceof Error ? err.message : String(err),
          responseBody: text,
        });
        throw err;
      }
    }

    if (RETRYABLE_STATUSES.includes(res.status)) {
      lastTransient = new TransientGatewayError(`midtrans ${res.status}: ${sanitize(text)}`, 'midtrans', res.status);
      logger.warn({
        ...logBase,
        attempt,
        outcome: 'retry',
        errorClass: res.status === 429 ? 'rate_limited' : 'gateway_5xx',
        status: res.status,
        elapsedMs: Date.now() - startedAt,
      });
      record({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        httpStatus: res.status,
        outcome: IntegrationOutcome.HTTP_ERROR,
        errorClass: res.status === 429 ? 'rate_limited' : 'gateway_5xx',
        errorMessage: sanitize(text),
        responseBody: text,
      });
      continue;
    }

    // Any other status (401 bad key, 406 duplicate order_id, 4xx validation) is a
    // decision by Midtrans — repeating it would just repeat the rejection.
    logger.error({ ...logBase, attempt, outcome: 'failed', errorClass: 'permanent', status: res.status, elapsedMs: Date.now() - startedAt });
    record({
      attempt,
      durationMs: Date.now() - attemptStartedAt,
      httpStatus: res.status,
      outcome: IntegrationOutcome.HTTP_ERROR,
      errorClass: 'permanent',
      errorMessage: sanitize(text),
      responseBody: text,
    });
    throw new PermanentGatewayError(`midtrans ${res.status}: ${sanitize(text)}`, 'midtrans', res.status);
  }

  logger.error({ ...logBase, outcome: 'failed', errorClass: 'transient_exhausted', elapsedMs: Date.now() - startedAt });
  throw lastTransient ?? new TransientGatewayError('midtrans request failed', 'midtrans');
}

/** A 2xx with an unparseable body is a broken contract, not a transient glitch. */
function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PermanentGatewayError(`invalid JSON response: ${sanitize(text)}`, 'midtrans');
  }
}
