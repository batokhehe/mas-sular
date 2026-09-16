import { Body, Controller, HttpCode, Logger, Optional, Post, ValidationPipe } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { randomUUID } from 'crypto';
import { safeRecord } from '../../../../infrastructure/integration-log/safe-record';
import { IntegrationLogService } from '../../../../infrastructure/integration-log/integration-log.service';
import { MidtransWebhookDto } from '../application/dto/midtrans-webhook.dto';
import { PaymentWebhookService, WebhookAck } from '../payment-webhook.service';

/**
 * Server-to-server gateway notification receiver.
 *
 * Authentication is the Midtrans signature and nothing else — no JwtAuthGuard,
 * no AdminGuard, no PermissionGuard (Midtrans holds no credential of ours). The
 * existing global guards are left in place rather than bypassed:
 *
 *   • ThrottlerGuard  — skipped for THIS route only (`@SkipThrottle`). Every
 *     Midtrans notification arrives from a small pool of shared IPs, so the
 *     global 120/min bucket would 429 legitimate retry storms. Nothing else is
 *     de-throttled.
 *   • CsrfGuard       — needs no change: it only enforces on cookie-authenticated
 *     requests, and a webhook carries no auth cookie, so it passes through.
 *   • No global auth guard exists, so the route is reachable by design.
 *
 * The route-scoped ValidationPipe intentionally differs from the global one:
 * `forbidNonWhitelisted: false` (Midtrans adds fields over time and a 400 would
 * cause endless retries) and implicit conversion OFF (so `gross_amount` reaches
 * the verifier as the exact string that was signed).
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentWebhookController {
  /** Only ever used to report a failed integration-log write (best-effort). */
  private readonly logger = new Logger('PaymentWebhookController');

  constructor(
    private readonly webhooks: PaymentWebhookService,
    // P1 integration logging (INBOUND). Recorded AFTER the service has run, so
    // signature verification, fingerprint dedup and replay protection are untouched.
    // `signature_key` is a sensitive key and is redacted by the sanitizer.
    @Optional() private readonly integrationLogs?: IntegrationLogService,
  ) {}

  private record(body: Record<string, unknown>, httpStatus: number, durationMs: number, errorMessage?: string): void {
    safeRecord(this.integrationLogs, {
      provider: IntegrationProvider.MIDTRANS,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      operationId: randomUUID(),
      correlationId: typeof body?.order_id === 'string' ? body.order_id : null,
      method: 'POST',
      endpoint: '/api/v1/payments/webhook/midtrans',
      httpStatus,
      durationMs,
      applicationOutcome: httpStatus < 400 ? IntegrationOutcome.OK : IntegrationOutcome.REJECTED,
      errorMessage: errorMessage ?? null,
      requestPayload: body,
    }, (err) =>
      this.logger?.warn({ event: 'integration_log.record_failed', reason: err instanceof Error ? err.message : String(err) }),
    );
  }

  /**
   * POST /api/v1/payments/webhook/midtrans
   *   200 { received: true, handled: false }  verified and recorded
   *   401                                     invalid/missing signature
   *   400                                     malformed payload (missing signature inputs)
   *   503                                     gateway disabled in this environment
   *
   * The 200 body is FLAT ON PURPOSE. Applied, duplicate, superseded and
   * unknown-transaction all answer identically, so the endpoint cannot be used to
   * discover whether an order exists or whether a notification has been seen before.
   * `handled: false` stays truthful: no business settlement happens until Phase 5D.
   */
  @Post('webhook/midtrans')
  @HttpCode(200)
  @SkipThrottle()
  async midtrans(@Body() body: Record<string, unknown>): Promise<WebhookAck> {
    // Validated EXPLICITLY, not by a route pipe (Phase 5H.3). Nest applies global
    // pipes IN ADDITION to route-scoped ones, so main.ts's
    // `forbidNonWhitelisted: true` ran first and rejected every real notification
    // with 400 — Midtrans sends channel-specific fields (`transaction_type`,
    // `expiry_time`, `customer_details`, `va_numbers`, `masked_card`, …) that no
    // fixed DTO can enumerate ahead of time.
    //
    // Declaring the parameter as a plain object gives it the `Object` metatype,
    // which ValidationPipe skips — so the global pipe passes the body through
    // untouched and this call becomes the single validation authority. Every
    // constraint still applies: the four signature-covered fields remain required,
    // and `gross_amount` keeps the exact string Midtrans signed.
    const startedAt = Date.now();
    try {
      const dto = await WEBHOOK_VALIDATION.transform(body, { type: 'body', metatype: MidtransWebhookDto });
      await this.webhooks.handleMidtransNotification(dto);
      this.record(body, 200, Date.now() - startedAt);
      return { received: true, handled: false };
    } catch (err) {
      // Recorded, then rethrown UNCHANGED: the rejection (401 bad signature, 400
      // malformed, 503 disabled) reaches Midtrans exactly as before.
      const status = typeof (err as { getStatus?: () => number })?.getStatus === 'function' ? (err as { getStatus: () => number }).getStatus() : 500;
      this.record(body, status, Date.now() - startedAt, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

/**
 * The webhook's own validation. Tolerant of unknown provider fields
 * (`forbidNonWhitelisted: false`) but strict about everything it declares, and
 * with implicit conversion OFF so `gross_amount` reaches the verifier as the exact
 * string that was signed ("40000.00" must never become 40000).
 */
const WEBHOOK_VALIDATION = new ValidationPipe({
  whitelist: false,
  forbidNonWhitelisted: false,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});
