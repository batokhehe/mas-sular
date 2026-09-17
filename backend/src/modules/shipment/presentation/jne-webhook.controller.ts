import { Body, Controller, Headers, HttpCode, Logger, Optional, Post, Req, Res } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { randomUUID } from 'crypto';
import { safeRecord } from '../../../infrastructure/integration-log/safe-record';
import { IntegrationLogService } from '../../../infrastructure/integration-log/integration-log.service';
import { rawBodyText, sentJsonBody } from '../../../infrastructure/integration-log/raw-body';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JneWebhookBody, JneWebhookService } from '../jne-webhook.service';

/**
 * JNE Webhook Status V2 receiver: POST /api/v1/shipments/webhook/jne
 * (public URL = APP_URL + that path; register it with JNE per environment).
 *
 * Responses are EXACTLY the documented bodies - `{ "status": true }` on success,
 * `{ "status": false, "reason": "..." }` on failure - with conventional HTTP codes:
 *   200  accepted: processed, recorded, or an already-processed duplicate
 *   400  invalid payload             404  unknown AWB
 *   409  order_id / AWB mismatch     415  not application/json
 *   503  JNE_WEBHOOK_ENABLED is not "true"
 *   500  unexpected failure (nothing written; JNE may retry)
 * The service returns these instead of throwing, so the global exception filter's
 * `{ statusCode, message }` shape never reaches JNE.
 *
 * AUTHENTICATION: JNE's V2 documentation specifies none, and none is invented here.
 * The body's `signature` field is the recipient's signature IMAGE URL, not a request
 * signature. Protection is operational: the endpoint is off until enabled, the AWB
 * must belong to a JNE shipment AND order_id must match it, transitions are
 * forward-only, and the reverse proxy should restrict the path to JNE's source IPs.
 *
 * Global guards stay in place: CsrfGuard passes (no auth cookie on a webhook), and
 * the throttler applies with a higher per-IP ceiling for this route only, because
 * JNE pushes from a small pool of addresses.
 */
@ApiTags('shipments')
@Controller({ path: 'shipments', version: '1' })
export class JneWebhookController {
  /** Only ever used to report a failed integration-log write (best-effort). */
  private readonly logger = new Logger('JneWebhookController');

  constructor(
    private readonly webhooks: JneWebhookService,
    // P1 integration logging (INBOUND). Optional and best-effort: it runs AFTER the
    // service has decided, so validation, AWB/order matching and the forward-only
    // transition rules are untouched.
    @Optional() private readonly integrationLogs?: IntegrationLogService,
  ) {}

  /** One record per received webhook. The signature header is never passed in. */
  private record(
    body: Record<string, unknown>,
    httpStatus: number,
    durationMs: number,
    reason?: string,
    exchange: { requestBody?: string | null; responseBody?: string | null } = {},
  ): void {
    safeRecord(this.integrationLogs, {
      provider: IntegrationProvider.JNE,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      operationId: randomUUID(),
      correlationId: typeof body?.awb === 'string' ? body.awb : null,
      method: 'POST',
      endpoint: '/api/v1/shipments/webhook/jne',
      httpStatus,
      durationMs,
      applicationOutcome: httpStatus < 400 ? IntegrationOutcome.OK : IntegrationOutcome.REJECTED,
      errorMessage: reason ?? null,
      requestPayload: body,
      // Exact exchange for the SUPER_ADMIN detail view; the sanitized column still
      // comes from requestPayload.
      requestBody: exchange.requestBody ?? null,
      responseBody: exchange.responseBody ?? null,
    }, (err) =>
      this.logger?.warn({ event: 'integration_log.record_failed', reason: err instanceof Error ? err.message : String(err) }),
    );
  }

  @Post('webhook/jne')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async jne(
    // A plain object type gives the parameter the `Object` metatype, which the global
    // ValidationPipe (forbidNonWhitelisted) skips - JNE's body is validated by the
    // domain parser instead, which tolerates fields JNE may add later.
    @Body() body: Record<string, unknown>,
    @Headers('content-type') contentType: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: { rawBody?: unknown },
  ): Promise<JneWebhookBody> {
    const startedAt = Date.now();
    if (!/^application\/json\b/i.test(contentType ?? '')) {
      res.status(415);
      const rejection: JneWebhookBody = { status: false, reason: 'Content-Type must be application/json' };
      this.record(body, 415, Date.now() - startedAt, rejection.reason, { requestBody: rawBodyText(req), responseBody: sentJsonBody(rejection) });
      return rejection;
    }
    const result = await this.webhooks.handle(body);
    res.status(result.httpStatus);
    this.record(body, result.httpStatus, Date.now() - startedAt, 'reason' in result.body ? result.body.reason : undefined, {
      requestBody: rawBodyText(req),
      responseBody: sentJsonBody(result.body),
    });
    return result.body;
  }
}
