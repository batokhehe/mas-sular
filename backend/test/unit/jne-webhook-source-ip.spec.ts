import 'reflect-metadata';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { validateEnv } from '../../src/common/config/env.validation';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';
import {
  isAllowedJneSource,
  JNE_CONFIRMED_WEBHOOK_SOURCE_IPS,
  jneWebhookSourceIpIssue,
  loadJneWebhookConfig,
  normalizeIp,
} from '../../src/modules/shipment/jne-webhook.config';
import { JneWebhookService } from '../../src/modules/shipment/jne-webhook.service';
import { JneWebhookController } from '../../src/modules/shipment/presentation/jne-webhook.controller';

/**
 * JNE webhook source-IP rule. JNE confirmed in writing that it pushes from
 * 110.239.85.204. Production trusts only confirmed addresses; outside production an
 * operator may list explicit extra addresses (the agreed Postman test push).
 * The HTTP behaviour behind the reverse proxy is covered in jne-webhook.http.spec.ts.
 */

const JNE_IP = '110.239.85.204';

describe('JNE webhook source-IP configuration', () => {
  it('the confirmed JNE webhook source is exactly 110.239.85.204 (nothing invented)', () => {
    expect(JNE_CONFIRMED_WEBHOOK_SOURCE_IPS).toEqual([JNE_IP]);
  });

  it('default (no extra setting) trusts the confirmed JNE address only, in every environment', () => {
    for (const JNE_ENVIRONMENT of [undefined, 'sandbox', 'production']) {
      const config = loadJneWebhookConfig({ JNE_WEBHOOK_ENABLED: 'true', JNE_ENVIRONMENT });
      expect(config).toEqual({ enabled: true, allowedSourceIps: [JNE_IP] });
      expect(isAllowedJneSource(config, JNE_IP)).toBe(true);
      expect(isAllowedJneSource(config, '::ffff:110.239.85.204')).toBe(true); // IPv4-mapped form
      for (const other of ['110.239.85.205', '127.0.0.1', '10.0.0.1', '::1', '', 'unknown']) {
        expect([other, isAllowedJneSource(config, other)]).toEqual([other, false]);
      }
      expect(isAllowedJneSource(config, undefined)).toBe(false);
    }
  });

  it('a config without an explicit list falls back to the confirmed address, never to "everyone"', () => {
    expect(isAllowedJneSource({ enabled: true }, JNE_IP)).toBe(true);
    expect(isAllowedJneSource({ enabled: true }, '8.8.8.8')).toBe(false);
  });

  it('outside production an operator may add explicit test addresses (e.g. the Postman tester)', () => {
    const config = loadJneWebhookConfig({ JNE_WEBHOOK_ENABLED: 'true', JNE_ENVIRONMENT: 'sandbox', JNE_WEBHOOK_EXTRA_SOURCE_IPS: ' 203.0.113.7 , 2001:db8::1 ' });
    expect(config.allowedSourceIps).toEqual([JNE_IP, '203.0.113.7', '2001:db8::1']);
    expect(isAllowedJneSource(config, '203.0.113.7')).toBe(true);
    expect(isAllowedJneSource(config, '2001:DB8::1')).toBe(true);
    expect(isAllowedJneSource(config, JNE_IP)).toBe(true); // the confirmed address is always kept
    expect(isAllowedJneSource(config, '203.0.113.8')).toBe(false);
  });

  it('production refuses any address JNE has not confirmed (the process does not start)', () => {
    const env = { JNE_WEBHOOK_ENABLED: 'true', JNE_ENVIRONMENT: 'production', JNE_WEBHOOK_EXTRA_SOURCE_IPS: '203.0.113.7' };
    expect(jneWebhookSourceIpIssue(env)).toMatch(/may not add addresses JNE has not confirmed/);
    expect(() => loadJneWebhookConfig(env)).toThrow(/203\.0\.113\.7/);
    // Re-listing the confirmed address itself is harmless.
    expect(loadJneWebhookConfig({ ...env, JNE_WEBHOOK_EXTRA_SOURCE_IPS: JNE_IP }).allowedSourceIps).toEqual([JNE_IP]);
  });

  it.each(['*', '0.0.0.0/0', '110.239.85.0/24', 'jne.co.id', '110.239.85.204,,nope'])('a non-address entry %p fails closed', (bad) => {
    expect(() => loadJneWebhookConfig({ JNE_WEBHOOK_EXTRA_SOURCE_IPS: bad })).toThrow(/must be a comma-separated list of IP addresses/);
  });

  it('normalizeIp: canonical comparison form', () => {
    expect(normalizeIp('::ffff:110.239.85.204')).toBe(JNE_IP);
    expect(normalizeIp(' 110.239.85.204 ')).toBe(JNE_IP);
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('boot validation (validateEnv)', () => {
  const base: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
    GOOGLE_CLIENT_ID: 'google-client-id',
    APP_URL: 'https://shop.example.com',
    CORS_ORIGINS: 'https://shop.example.com',
    CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
    TRUST_PROXY_HOPS: '1',
  };

  it('accepts the default and explicit non-production test addresses', () => {
    expect(() => validateEnv(base)).not.toThrow();
    expect(() => validateEnv({ ...base, JNE_ENVIRONMENT: 'sandbox', JNE_WEBHOOK_EXTRA_SOURCE_IPS: '203.0.113.7' })).not.toThrow();
  });

  it('rejects unconfirmed addresses with JNE_ENVIRONMENT=production, and malformed lists anywhere', () => {
    expect(() => validateEnv({ ...base, JNE_ENVIRONMENT: 'production', JNE_WEBHOOK_EXTRA_SOURCE_IPS: '203.0.113.7' })).toThrow(/JNE_WEBHOOK_EXTRA_SOURCE_IPS/);
    expect(() => validateEnv({ ...base, JNE_WEBHOOK_EXTRA_SOURCE_IPS: '*' })).toThrow(/JNE_WEBHOOK_EXTRA_SOURCE_IPS/);
  });
});

describe('source refusal: answer and integration log', () => {
  const resStub = () => {
    const r = { statusCode: 0, status(code: number) { r.statusCode = code; return r; } };
    return r;
  };

  it('403 with the documented failure body, recorded as one REJECTED INBOUND row; processing never runs', async () => {
    const entries: IntegrationLogEntry[] = [];
    const logs = { write: jest.fn() };
    const service = new JneWebhookService({} as never, {} as never, { enabled: true }, logs as never);
    const handle = jest.spyOn(service, 'handle');
    const controller = new JneWebhookController(service, { record: (e: IntegrationLogEntry) => entries.push(e) } as never);
    const res = resStub();
    const body = { awb: 'JNE00099', order_id: 'BMS-1', status: 'DELIVERED' };

    await expect(controller.jne(body, 'application/json', res as never, { ip: '198.51.100.4', rawBody: Buffer.from(JSON.stringify(body)) })).resolves.toEqual({
      status: false,
      reason: 'source not allowed',
    });
    expect(res.statusCode).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      httpStatus: 403,
      applicationOutcome: IntegrationOutcome.REJECTED,
      errorMessage: 'source not allowed',
      correlationId: 'JNE00099',
      responseBody: JSON.stringify({ status: false, reason: 'source not allowed' }),
    });
    expect(logs.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'jne.source_rejected', metadata: { provider: 'jne', sourceIp: '198.51.100.4' } }));
  });

  it('the confirmed JNE address passes the check and reaches normal processing', async () => {
    const service = new JneWebhookService({} as never, {} as never, { enabled: false });
    const controller = new JneWebhookController(service);
    const res = resStub();
    // With the endpoint disabled, reaching the service shows the source check passed.
    await expect(controller.jne({}, 'application/json', res as never, { ip: '::ffff:110.239.85.204' })).resolves.toEqual({
      status: false,
      reason: 'JNE webhook is not enabled',
    });
    expect(res.statusCode).toBe(503);
  });
});
