import { Body, Controller, Headers, HttpCode, Logger, Optional, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { randomUUID } from 'crypto';
import { safeRecord } from '../../../infrastructure/integration-log/safe-record';
import { IntegrationLogService } from '../../../infrastructure/integration-log/integration-log.service';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PaxelWebhookBody, PaxelWebhookService } from '../paxel-webhook.service';

/**
 * Paxel webhook receiver: POST /api/v1/shipments/webhook/paxel
 * (public URL = APP_URL + that path; register it with Paxel per environment).
 *
 *   200 { received: true }                     accepted: processed, recorded, or a duplicate
 *   400 { received: false, reason }            invalid payload
 *   401 { received: false, reason }            X-Paxel-Signature missing or invalid
 *   404 { received: false, reason }            no Paxel shipment has this airwaybill_code
 *   409 { received: false, reason }            invoice_number mismatch / shipment changed
 *   415 { received: false, reason }            not application/json
 *   503 { received: false, reason }            PAXEL_WEBHOOK_ENABLED is not "true"
 *   500 { received: false, reason }            unexpected failure (nothing written)
 * The acknowledgement Paxel expects is NEEDS PAXEL CONFIRMATION (see the service).
 *
 * AUTHENTICATION is the `X-Paxel-Signature` header, verified in constant time. The
 * body's `signature` / `pdo_signature` / `photo` fields are delivery media links,
 * not authentication. The header is redacted from request logs (app.module).
 *
 * Global guards stay in place: CsrfGuard passes (no auth cookie on a webhook), and
 * the throttler applies with a higher per-IP ceiling for this route only - the same
 * arrangement as the JNE webhook, because a courier pushes from a small pool of
 * addresses.
 */
@ApiTags('shipments')
@Controller({ path: 'shipments', version: '1' })
export class PaxelWebhookController {
  /** Only ever used to report a failed integration-log write (best-effort). */
  private readonly logger = new Logger('PaxelWebhookController');

  constructor(
    private readonly webhooks: PaxelWebhookService,
    // P1 integration logging (INBOUND). Runs AFTER the service has verified the
    // HMAC signature and decided; signature verification is untouched, and the
    // signature header itself is never handed to the recorder.
    @Optional() private readonly integrationLogs?: IntegrationLogService,
  ) {}

  private record(body: Record<string, unknown>, httpStatus: number, durationMs: number, reason?: string): void {
    safeRecord(this.integrationLogs, {
      provider: IntegrationProvider.PAXEL,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      operationId: randomUUID(),
      correlationId: typeof body?.airwaybill_code === 'string' ? body.airwaybill_code : null,
      method: 'POST',
      endpoint: '/api/v1/shipments/webhook/paxel',
      httpStatus,
      durationMs,
      applicationOutcome: httpStatus < 400 ? IntegrationOutcome.OK : IntegrationOutcome.REJECTED,
      errorMessage: reason ?? null,
      requestPayload: body,
    }, (err) =>
      this.logger?.warn({ event: 'integration_log.record_failed', reason: err instanceof Error ? err.message : String(err) }),
    );
  }

  @Post('webhook/paxel')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async paxel(
    // A plain object type gives the parameter the `Object` metatype, which the global
    // ValidationPipe (forbidNonWhitelisted) skips - Paxel's body is validated by the
    // domain parser instead, which tolerates fields Paxel may add.
    @Body() body: Record<string, unknown>,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-paxel-signature') signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaxelWebhookBody> {
    const startedAt = Date.now();
    const result = await this.webhooks.handle(body, { contentType, signature });
    res.status(result.httpStatus);
    this.record(body, result.httpStatus, Date.now() - startedAt, 'reason' in result.body ? result.body.reason : undefined);
    return result.body;
  }
}
