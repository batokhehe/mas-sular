import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { readFileSync } from 'fs';
import { AddressInfo } from 'net';
import { join } from 'path';
import { validateEnv } from '../../src/common/config/env.validation';
import { configureTrustProxy, resolveTrustProxyHops } from '../../src/common/http/trust-proxy';

/**
 * Production-readiness B3. Behind the reverse proxy every connection comes from the
 * proxy; without trust, ThrottlerGuard (keyed on req.ip) put every visitor into one
 * bucket (125 distinct X-Forwarded-For values: request #121 got 429). The test
 * client connects from 127.0.0.1, which plays the proxy here; X-Forwarded-For is written
 * the way a proxy writes it — whatever the client sent, then the address the proxy
 * saw appended on the RIGHT.
 */
const LIMIT = 3;
// Each HTTP case boots a real Nest app and makes real requests; Jest's 5 s default is
// too tight when the whole suite runs in parallel (observed once in a full run).
const HTTP_TEST_TIMEOUT_MS = 30_000;

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: LIMIT }])],
  controllers: [PingController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class ThrottledModule {}

async function appWith(env: NodeJS.ProcessEnv): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ThrottledModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureTrustProxy(app, env); // exactly what main.ts calls
  await app.listen(0, '127.0.0.1');
  return app;
}

/** One request as it arrives from the proxy: `clientSent` is client-controlled, `seenByProxy` is not. */
function viaProxy(app: INestApplication, seenByProxy: string, clientSent?: string) {
  const xff = clientSent ? `${clientSent}, ${seenByProxy}` : seenByProxy;
  const { port } = app.getHttpServer().address() as AddressInfo;
  const pending = fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'X-Forwarded-For': xff } });
  return {
    async expect(status: number) {
      const res = await pending;
      await res.arrayBuffer();
      expect(res.status).toBe(status);
    },
  };
}

describe('B3 trust proxy: rate limiting behind one reverse-proxy hop', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  it('distinct forwarded client IPs get independent rate-limit buckets', async () => {
    app = await appWith({ TRUST_PROXY_HOPS: '1' });
    // 5 clients x LIMIT requests = 15 requests, 5x the per-client limit: all allowed.
    for (let client = 1; client <= 5; client++) {
      for (let i = 0; i < LIMIT; i++) {
        await viaProxy(app, `203.0.113.${client}`).expect(200);
      }
    }
  }, HTTP_TEST_TIMEOUT_MS);

  it('one client exceeding the limit still gets 429, and only that client', async () => {
    app = await appWith({ TRUST_PROXY_HOPS: '1' });
    for (let i = 0; i < LIMIT; i++) await viaProxy(app, '203.0.113.10').expect(200);
    await viaProxy(app, '203.0.113.10').expect(429);
    await viaProxy(app, '203.0.113.11').expect(200); // a neighbour is unaffected
  }, HTTP_TEST_TIMEOUT_MS);

  it('a client cannot escape its bucket by forging X-Forwarded-For entries', async () => {
    app = await appWith({ TRUST_PROXY_HOPS: '1' });
    // The client rotates the value IT sends; the proxy-appended address stays its real one.
    for (let i = 0; i < LIMIT; i++) {
      await viaProxy(app, '198.51.100.7', `10.0.0.${i}`).expect(200);
    }
    await viaProxy(app, '198.51.100.7', '10.0.0.250').expect(429);
    await viaProxy(app, '198.51.100.7', '203.0.113.99, 10.9.9.9').expect(429);
  }, HTTP_TEST_TIMEOUT_MS);

  it('with no trusted hop (local default) forwarded headers are ignored entirely', async () => {
    // The pre-B3 behaviour, kept for direct (proxy-less) local access: nothing a client
    // sends can pick the bucket, so every request here counts against 127.0.0.1.
    app = await appWith({});
    for (let i = 0; i < LIMIT; i++) await viaProxy(app, `203.0.113.${i + 20}`).expect(200);
    await viaProxy(app, '203.0.113.99').expect(429);
  }, HTTP_TEST_TIMEOUT_MS);
});

describe('B3 trust proxy configuration', () => {
  it('resolves an explicit hop count and never "trust everything"', () => {
    expect(resolveTrustProxyHops({})).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    for (const bad of ['true', '-1', '4', '1.5', 'one']) {
      expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('applies the hop count as a number to the Express setting', () => {
    const set = jest.fn();
    expect(configureTrustProxy({ set }, { TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(set).toHaveBeenCalledWith('trust proxy', 1);
  });

  const PROD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
    GOOGLE_CLIENT_ID: 'google-client-id',
    APP_URL: 'https://api.example.invalid',
    CORS_ORIGINS: 'https://shop.example.invalid',
    CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
  };

  it('is required at boot in staging/production and validated as a small integer', () => {
    expect(() => validateEnv(PROD)).toThrow(/TRUST_PROXY_HOPS must be set/);
    expect(() => validateEnv({ ...PROD, NODE_ENV: 'staging' })).toThrow(/TRUST_PROXY_HOPS must be set/);
    expect(() => validateEnv({ ...PROD, TRUST_PROXY_HOPS: 'true' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => validateEnv({ ...PROD, TRUST_PROXY_HOPS: '9' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => validateEnv({ ...PROD, TRUST_PROXY_HOPS: '1' })).not.toThrow();
  });

  it('stays optional locally (no proxy in front of the dev API)', () => {
    expect(() => validateEnv({ ...PROD, NODE_ENV: 'development', CHECKOUT_IDEMPOTENCY_ENABLED: 'false' })).not.toThrow();
  });

  it('main.ts applies it before the app starts serving', () => {
    const main = readFileSync(join(__dirname, '../../src/main.ts'), 'utf8');
    expect(main).toMatch(/configureTrustProxy\(app\)/);
    expect(main.indexOf('configureTrustProxy(app)')).toBeLessThan(main.indexOf('app.listen('));
  });
});
