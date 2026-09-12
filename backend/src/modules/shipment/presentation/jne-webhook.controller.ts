import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
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
  constructor(private readonly webhooks: JneWebhookService) {}

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
  ): Promise<JneWebhookBody> {
    if (!/^application\/json\b/i.test(contentType ?? '')) {
      res.status(415);
      return { status: false, reason: 'Content-Type must be application/json' };
    }
    const result = await this.webhooks.handle(body);
    res.status(result.httpStatus);
    return result.body;
  }
}
