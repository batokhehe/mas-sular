import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { getRequestId } from '../logging/request-context';
import { INTEGRATION_LOG_CONFIG, IntegrationLogConfig } from './integration-log.config';
import { sanitizeBody, sanitizeEndpoint, sanitizeErrorText, sanitizePayload } from './integration-log.sanitizer';
import { IntegrationLogEntry, IntegrationRecorder } from './integration-log.types';

const ERROR_MESSAGE_MAX = 512;
const OPERATION_MAX = 48;
/** Matches the VarChar(36) id columns — a UUID is exactly 36 characters. */
const ID_MAX = 36;

/**
 * Best-effort persistence of one external API exchange, modelled on LogService:
 * synchronous call, nothing awaited, every error swallowed. A provider call must
 * never fail, retry differently, or be classified differently because logging
 * failed - the failure itself is reported through the existing Pino logger.
 *
 * `requestId` is auto-filled from the AsyncLocalStorage request context when the
 * caller does not supply one (workers simply have none).
 */
@Injectable()
export class IntegrationLogService implements IntegrationRecorder {
  private readonly logger = new Logger('IntegrationLogService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(INTEGRATION_LOG_CONFIG) private readonly config: IntegrationLogConfig,
  ) {}

  record(entry: IntegrationLogEntry): void {
    if (!this.config.enabled) return;
    try {
      void this.persist(entry).catch((err) => this.reportFailure(entry, err));
    } catch (err) {
      // A synchronous throw (sanitizer, bad input) must not reach the caller either.
      this.reportFailure(entry, err);
    }
  }

  private async persist(entry: IntegrationLogEntry): Promise<void> {
    await this.prisma.integrationApiLog.create({ data: this.toRow(entry) });
  }

  /** Pure mapping + sanitization. Exported behaviour is asserted by the unit tests. */
  private toRow(entry: IntegrationLogEntry): Prisma.IntegrationApiLogCreateInput {
    const opts = this.config.sanitize;
    const request =
      entry.requestPayload !== undefined
        ? sanitizePayload(entry.requestPayload, opts)
        : sanitizeBody(entry.requestBody, entry.requestContentType ?? undefined, opts);
    const response =
      entry.responsePayload !== undefined
        ? sanitizePayload(entry.responsePayload, opts)
        : sanitizeBody(entry.responseBody, entry.responseContentType ?? undefined, opts);

    return {
      provider: entry.provider,
      operation: entry.operation.slice(0, OPERATION_MAX),
      direction: entry.direction,
      operationId: entry.operationId.slice(0, 36),
      attempt: entry.attempt ?? null,
      maxAttempts: entry.maxAttempts ?? null,
      requestId: (entry.requestId ?? getRequestId() ?? null)?.slice(0, 64) ?? null,
      correlationId: entry.correlationId?.slice(0, 128) ?? null,
      orderId: entry.orderId?.slice(0, ID_MAX) ?? null,
      paymentId: entry.paymentId?.slice(0, ID_MAX) ?? null,
      shipmentId: entry.shipmentId?.slice(0, ID_MAX) ?? null,
      method: entry.method?.slice(0, 8) ?? null,
      endpoint: sanitizeEndpoint(entry.endpoint),
      httpStatus: entry.httpStatus ?? null,
      durationMs: entry.durationMs ?? null,
      applicationOutcome: entry.applicationOutcome,
      errorClass: entry.errorClass?.slice(0, 32) ?? null,
      // The transports pass the provider's RAW body here (already truncated to 300
      // characters). It gets the same credential/PII/JWT policy as the payload
      // columns before it is persisted; the error the provider THREW is untouched.
      errorMessage: sanitizeErrorText(entry.errorMessage, ERROR_MESSAGE_MAX),
      sanitizedRequest: (request ?? undefined) as Prisma.InputJsonValue | undefined,
      sanitizedResponse: (response ?? undefined) as Prisma.InputJsonValue | undefined,
    };
  }

  /**
   * The ONLY consequence of a logging failure: a log line through the existing
   * application logger. No rethrow, no metric of the business operation, no change
   * to what the provider call returned.
   */
  private reportFailure(entry: IntegrationLogEntry, err: unknown): void {
    this.logger.error({
      event: 'integration_log.persist_failed',
      provider: entry.provider,
      operation: entry.operation,
      operationId: entry.operationId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
