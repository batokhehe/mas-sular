import { Global, INestApplication, Module, NotFoundException, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import * as bcrypt from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { AddressInfo } from 'net';
import { Logger, LoggerModule } from 'nestjs-pino';
import { tmpdir } from 'os';
import { join } from 'path';
import { Writable } from 'stream';
import { CsrfGuard } from '../../src/common/auth/csrf.guard';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { corsOptions, originRejectionMiddleware } from '../../src/common/http/cors-policy';
import { PINO_HTTP_REDACT } from '../../src/common/logging/redact';
import { PrismaService } from '../../src/database/prisma.service';
import { AdminNotificationDispatcher } from '../../src/infrastructure/admin-notifications/admin-notification.dispatcher';
import { AdminNotificationMetrics } from '../../src/infrastructure/admin-notifications/admin-notification.metrics';
import { AdminNotificationRepository } from '../../src/infrastructure/admin-notifications/admin-notification.repository';
import { SseHubService } from '../../src/infrastructure/admin-notifications/sse-hub.service';
import { AdminAuthModule } from '../../src/modules/admin-auth/admin-auth.module';
import { AdminBellController } from '../../src/modules/admin/presentation/admin-bell.controller';
import { JwtStrategy } from '../../src/modules/auth/infrastructure/jwt.strategy';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { PaymentsController } from '../../src/modules/payments/presentation/payments.controller';
import { UploadController } from '../../src/modules/upload/upload.controller';
import { UploadService } from '../../src/modules/upload/upload.service';
import { MAX_UPLOAD_SIZE_BYTES, publicUploadDir } from '../../src/modules/upload/upload.util';
import { ALL_PERMISSION_NAMES } from '../../prisma/bootstrap/permission-catalogue';

/**
 * End-to-end over REAL HTTP (real Nest routing, guards, CsrfGuard, ValidationPipe,
 * ThrottlerGuard, Multer, cookie-parser and nestjs-pino with the production redact
 * config) for the admin-session, SSE, upload and receipt hardening:
 *
 *   H2  SSE authenticates with the session cookie; ?token= is refused; no JWT in logs
 *   H3  unauthorised uploads never create a file
 *   H4  cookie-only access token, refresh tokens rejected, expiry, logout revokes
 *   H5  login throttle + recovery, comparable failure paths
 *   L5  CORS: approved origins pass, others get a clean 403
 *   L7/L8 upload permission, private receipts
 *
 * Only Prisma and Redis are replaced (in-memory stand-ins).
 */

jest.setTimeout(60_000);

const ADMIN_SECRET = 'http-spec-admin-secret-000000000000000000';
const CUSTOMER_SECRET = 'http-spec-customer-secret-00000000000000';
const STOREFRONT = 'https://shop.example.test';
const ADMIN_UI = 'https://admin.example.test';
const PASSWORD = 'correct-horse-battery-staple';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;

interface AdminFixture { id: string; email: string; role: string; perms: string[] }
const ADMINS: AdminFixture[] = [
  { id: 'adm-super', email: 'super@test.local', role: 'SUPER_ADMIN', perms: [] },
  { id: 'adm-bell', email: 'bell@test.local', role: 'STAFF', perms: ['Notification.read', 'Payment.read'] },
  { id: 'adm-staff', email: 'staff@test.local', role: 'STAFF', perms: ['Order.read'] },
];

let passwordHash = '';

function memoryCache() {
  const m = new Map<string, unknown>();
  return {
    store: m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: unknown) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  };
}

function prismaStub() {
  const byId = (id: string) => ADMINS.find((a) => a.id === id);
  return {
    admin: {
      findUnique: jest.fn(async ({ where }: { where: { email: string } }) => {
        const a = ADMINS.find((x) => x.email === where.email);
        return a ? { id: a.id, email: a.email, name: a.email, isActive: true, passwordHash, roles: [{ role: { id: `role-${a.role}`, name: a.role } }] } : null;
      }),
    },
    rolePermission: {
      findMany: jest.fn(async ({ where }: { where: { role: { admins: { some: { adminId: string } } } } }) =>
        (byId(where.role.admins.some.adminId)?.perms ?? []).map((p) => ({ permission: { subject: p.split('.')[0], action: p.split('.')[1] } }))),
    },
    // AdminJwtStrategy's single join; the admin id is the first bound value.
    $queryRaw: jest.fn(async (sql: { values: unknown[] }) => {
      const a = byId(String(sql.values[0]));
      if (!a) return [];
      const base = { id: a.id, email: a.email, name: a.email, roleName: a.role };
      return a.perms.length ? a.perms.map((p) => ({ ...base, subject: p.split('.')[0], action: p.split('.')[1] })) : [{ ...base, subject: null, action: null }];
    }),
    user: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (['cust-1', 'cust-2'].includes(where.id) ? { id: where.id } : null)) },
  };
}

const RECEIPTS_OF_CUST_1 = new Set<string>();
const paymentsStub = {
  getUploadPage: jest.fn(async (token: string) => {
    if (token !== 'good-token') throw new NotFoundException('Upload link is invalid or has expired');
    return { ok: true };
  }),
  assertPaymentOwner: jest.fn(async (paymentId: string, userId: string) => {
    if (!(paymentId === 'pay-1' && userId === 'cust-1')) throw new NotFoundException('Payment not found');
  }),
  customerOwnsReceipt: jest.fn(async (filename: string, userId: string) => userId === 'cust-1' && RECEIPTS_OF_CUST_1.has(filename)),
};

interface Harness {
  app: INestApplication;
  base: string;
  logs: string[];
  cache: ReturnType<typeof memoryCache>;
  hub: { register: jest.Mock };
  uploadRoot: string;
}

async function startHarness(): Promise<Harness> {
  const uploadRoot = mkdtempSync(join(tmpdir(), 'ms-upload-'));
  Object.assign(process.env, {
    UPLOAD_ROOT: uploadRoot,
    APP_URL: 'http://api.example.test',
    JWT_ADMIN_ACCESS_TTL: '1h',
    COOKIE_DOMAIN: '.example.test', // the admin cookie must NOT use it (host-only, M4)
    COOKIE_SECURE: 'false',
    COOKIE_SAMESITE: 'lax',
    CSRF_MODE: 'enforce',
    AUTH_COOKIE_EXTRACTOR_ENABLED: 'true',
    CORS_ORIGINS: `${STOREFRONT},${ADMIN_UI}`,
  });

  const logs: string[] = [];
  const capture = new Writable({ write(chunk, _enc, cb) { logs.push(String(chunk)); cb(); } });
  const cache = memoryCache();
  const hub = {
    register: jest.fn((_adminId: string, res: import('express').Response) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('retry: 3000\n\n');
    }),
    activeConnections: () => 0,
  };

  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: prismaStub() }, { provide: CACHE_MANAGER, useValue: cache }],
    exports: [PrismaService, CACHE_MANAGER],
  })
  class StubInfra {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ jwt: { adminAccessSecret: ADMIN_SECRET, accessSecret: CUSTOMER_SECRET } })] }),
      LoggerModule.forRoot({ pinoHttp: [{ level: 'info', redact: PINO_HTTP_REDACT }, capture] }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
      StubInfra,
      AdminAuthModule,
    ],
    controllers: [AdminBellController, UploadController, PaymentsController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      JwtStrategy,
      UploadService,
      { provide: PaymentsService, useValue: paymentsStub },
      { provide: AdminNotificationRepository, useValue: {} },
      { provide: AdminNotificationDispatcher, useValue: {} },
      { provide: AdminNotificationMetrics, useValue: {} },
      { provide: SseHubService, useValue: hub },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  const allowed = [STOREFRONT, ADMIN_UI];
  app.use(originRejectionMiddleware(allowed));
  app.enableCors(corsOptions(allowed));
  app.use(cookieParser());
  app.useGlobalGuards(new CsrfGuard());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(logger, { write: jest.fn() } as never));
  app.useStaticAssets(publicUploadDir(), { prefix: '/uploads/', index: false, dotfiles: 'deny' });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, logs, cache, hub, uploadRoot };
}

async function stopHarness(h: Harness) {
  await h.app.close();
  rmSync(h.uploadRoot, { recursive: true, force: true });
}

/** Every file under a directory tree. */
function filesUnder(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    out = statSync(full).isDirectory() ? out.concat(filesUnder(full)) : out.concat(full);
  }
  return out;
}

const cookieValue = (setCookies: string[], name: string) =>
  setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1)?.slice(name.length + 1);

async function login(h: Harness, email: string, password = PASSWORD) {
  const res = await fetch(`${h.base}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookies = res.headers.getSetCookie();
  return { res, body: await res.json(), setCookies, token: cookieValue(setCookies, 'ms_admin_access') };
}

/** Cookie + CSRF double-submit headers, exactly as the admin UI sends them. */
const XSRF = 'test-xsrf-token-value';
const adminCookie = (token: string) => ({ Cookie: `ms_admin_access=${token}; XSRF-TOKEN=${XSRF}`, 'X-CSRF-Token': XSRF });

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

// ============================================================================
describe('H4 admin session over HTTP', () => {
  let h: Harness;
  let superToken = '';
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => stopHarness(h));

  it('login sets a host-only httpOnly cookie and returns NO token in the body', async () => {
    const { res, body, setCookies, token } = await login(h, 'super@test.local');
    expect(res.status).toBe(201);
    expect(token).toMatch(JWT_SHAPE);
    superToken = token!;

    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(JWT_SHAPE);
    expect(body.user.email).toBe('super@test.local');
    expect(body.user.role.name).toBe('SUPER_ADMIN');

    const adminCookieHeader = setCookies.find((c) => c.startsWith('ms_admin_access=ey'))!;
    expect(adminCookieHeader).toMatch(/HttpOnly/i);
    expect(adminCookieHeader).toMatch(/SameSite=Lax/i);
    expect(adminCookieHeader).toMatch(/Path=\//);
    expect(adminCookieHeader).not.toMatch(/Domain=/i); // host-only (M4)
    // The pre-H4 parent-domain copy is expired so it can never shadow the new cookie.
    expect(setCookies.some((c) => /^ms_admin_access=;/.test(c) && /Domain=\.?example\.test/i.test(c) && /Expires=Thu, 01 Jan 1970/i.test(c))).toBe(true);
  });

  it('the cookie alone authenticates /me, with the canonical SUPER_ADMIN catalogue', async () => {
    const res = await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${superToken}` } });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.role).toBe('SUPER_ADMIN');
    expect(me.permissions.sort()).toEqual([...ALL_PERMISSION_NAMES].sort());
  });

  it('no cookie / no token -> 401', async () => {
    expect((await fetch(`${h.base}/api/v1/admin/auth/me`)).status).toBe(401);
  });

  it('a REFRESH token signed with the admin secret is rejected as an access token (cookie and Bearer)', async () => {
    const jwt = new JwtService({ secret: ADMIN_SECRET });
    const refresh = jwt.sign({ sub: 'adm-super', email: 'super@test.local', type: 'refresh' }, { expiresIn: '7d' });
    const refreshWithSid = jwt.sign({ sub: 'adm-super', sid: 'whatever', typ: 'admin_refresh' }, { expiresIn: '7d' });
    for (const t of [refresh, refreshWithSid]) {
      expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${t}` } })).status).toBe(401);
      expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Authorization: `Bearer ${t}` } })).status).toBe(401);
    }
  });

  it('an EXPIRED access token is rejected even while its session exists', async () => {
    const sid = [...h.cache.store.keys()].find((k) => k.startsWith('admin-session:'))!.slice('admin-session:'.length);
    const expired = new JwtService({ secret: ADMIN_SECRET }).sign({ sub: 'adm-super', sid, typ: 'admin_access', exp: Math.floor(Date.now() / 1000) - 10 });
    expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${expired}` } })).status).toBe(401);
  });

  it('a token signed with another secret, or a forged alg:none token, is rejected', async () => {
    const foreign = new JwtService({ secret: CUSTOMER_SECRET }).sign({ sub: 'adm-super', sid: 'x', typ: 'admin_access' });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"adm-super","sid":"x","typ":"admin_access"}').toString('base64url')}.`;
    for (const t of [foreign, none]) {
      expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${t}` } })).status).toBe(401);
    }
  });

  it('logout without the CSRF header is refused (cookie-authenticated mutation)', async () => {
    const res = await fetch(`${h.base}/api/v1/admin/auth/logout`, { method: 'POST', headers: { Cookie: `ms_admin_access=${superToken}` } });
    expect(res.status).toBe(403);
  });

  it('logout revokes the server-side session: the same token no longer works', async () => {
    const { token } = await login(h, 'bell@test.local');
    expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${token}` } })).status).toBe(200);

    const out = await fetch(`${h.base}/api/v1/admin/auth/logout`, { method: 'POST', headers: adminCookie(token!) });
    expect(out.status).toBe(200);
    const cleared = out.headers.getSetCookie().find((c) => c.startsWith('ms_admin_access=;'));
    expect(cleared).toBeDefined();

    expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${token}` } })).status).toBe(401);
    // Other sessions are unaffected.
    expect((await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Cookie: `ms_admin_access=${superToken}` } })).status).toBe(200);
  });
});

// ============================================================================
describe('H2 admin SSE stream over HTTP', () => {
  let h: Harness;
  let bell = '';
  let staff = '';
  beforeAll(async () => {
    h = await startHarness();
    bell = (await login(h, 'bell@test.local')).token!;
    staff = (await login(h, 'staff@test.local')).token!;
  });
  afterAll(() => stopHarness(h));

  it('authenticated SSE works with the session cookie', async () => {
    const res = await fetch(`${h.base}/api/v1/admin/notifications/stream`, { headers: { Cookie: `ms_admin_access=${bell}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await res.text();
    expect(h.hub.register).toHaveBeenCalledWith('adm-bell', expect.anything());
  });

  it('unauthenticated SSE returns 401', async () => {
    h.hub.register.mockClear();
    expect((await fetch(`${h.base}/api/v1/admin/notifications/stream`)).status).toBe(401);
    expect(h.hub.register).not.toHaveBeenCalled();
  });

  it('token-in-query is rejected - alone, and even alongside a valid cookie', async () => {
    h.hub.register.mockClear();
    for (const key of ['token', 'access_token', 'jwt']) {
      const alone = await fetch(`${h.base}/api/v1/admin/notifications/stream?${key}=${bell}`);
      expect(alone.status).toBe(401);
      const withCookie = await fetch(`${h.base}/api/v1/admin/notifications/stream?${key}=${bell}`, { headers: { Cookie: `ms_admin_access=${bell}` } });
      expect(withCookie.status).toBe(401);
      expect(JSON.stringify(await withCookie.json())).not.toContain(bell); // the error body does not echo it
    }
    expect(h.hub.register).not.toHaveBeenCalled();
  });

  it('an admin without Notification.read gets 403', async () => {
    expect((await fetch(`${h.base}/api/v1/admin/notifications/stream`, { headers: { Cookie: `ms_admin_access=${staff}` } })).status).toBe(403);
  });

  it('logs contain no JWT value - not the issued tokens, not the ?token= ones, not Set-Cookie', async () => {
    await new Promise((r) => setTimeout(r, 50)); // let pino flush
    const text = h.logs.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('/admin/notifications/stream'); // the requests WERE logged
    expect(text).not.toContain(bell);
    expect(text).not.toContain(staff);
    expect(text).not.toMatch(JWT_SHAPE);
  });
});

// ============================================================================
describe('H5 admin login throttling over HTTP', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await stopHarness(h);
  });

  it('nonexistent email and wrong password are indistinguishable (status, body, and both pay for bcrypt)', async () => {
    const t0 = Date.now();
    const unknown = await login(h, 'nobody@test.local', 'wrong-password-123');
    const t1 = Date.now();
    const wrong = await login(h, 'super@test.local', 'wrong-password-123');
    const t2 = Date.now();

    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(unknown.setCookies.some((c) => c.startsWith('ms_admin_access=ey'))).toBe(false);
    // bcrypt cost 12 runs on BOTH paths (the unknown email used to return instantly).
    const unknownMs = t1 - t0;
    const wrongMs = t2 - t1;
    expect(unknownMs).toBeGreaterThan(50);
    expect(Math.max(unknownMs, wrongMs) / Math.min(unknownMs, wrongMs)).toBeLessThan(4);
  });

  it('repeated failed attempts are throttled per IP (429 on the 6th within a minute)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await login(h, 'staff@test.local', `wrong-${i}-password`)).res.status);
    // 2 attempts were spent in the previous test: attempts 3..6 in this window.
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    // Even the correct password is refused while throttled.
    expect((await login(h, 'staff@test.local')).res.status).toBe(429);
  });

  it('a successful login works again after the window passes', async () => {
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 16 * 60_000); // past the IP window and any account backoff
    const ok = await login(h, 'staff@test.local');
    expect(ok.res.status).toBe(201);
    expect(ok.token).toMatch(JWT_SHAPE);
  });
});

// ============================================================================
describe('H3 / L7 / L8 uploads over HTTP: nothing is written unless authorised', () => {
  let h: Harness;
  let superToken = '';
  let staffToken = '';
  let bellToken = '';
  const customer = (sub: string) => new JwtService({ secret: CUSTOMER_SECRET }).sign({ sub, email: `${sub}@c.test`, roles: ['CUSTOMER'] });
  const form = (bytes: Buffer, name = 'receipt.png', type = 'image/png') => {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    return f;
  };
  const post = (path: string, body: FormData, headers: Record<string, string> = {}) =>
    fetch(`${h.base}${path}`, { method: 'POST', body, headers });

  beforeAll(async () => {
    h = await startHarness();
    superToken = (await login(h, 'super@test.local')).token!;
    staffToken = (await login(h, 'staff@test.local')).token!;
    bellToken = (await login(h, 'bell@test.local')).token!;
  });
  afterAll(() => stopHarness(h));

  const assertNothingWritten = () => expect(filesUnder(h.uploadRoot)).toEqual([]);

  it('invalid upload token: 404 and the upload directory is unchanged (the audited 500 KB probe)', async () => {
    const res = await post('/api/v1/payments/upload/invalid-token/file', form(Buffer.alloc(500_000, 7)));
    expect(res.status).toBe(404);
    assertNothingWritten();
  });

  it('valid token but not really an image: 400, nothing written', async () => {
    const res = await post('/api/v1/payments/upload/good-token/file', form(Buffer.from('<?php echo 1; ?>'.padEnd(64, ' '))));
    expect(res.status).toBe(400);
    assertNothingWritten();
  });

  it('over the application size cap: 413, nothing written', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1024)]);
    const res = await post('/api/v1/payments/upload/good-token/file', form(big));
    expect(res.status).toBe(413);
    assertNothingWritten();
  });

  it('customer receipt route: no auth -> 401, someone else\'s payment -> 404; nothing written', async () => {
    expect((await post('/api/v1/payments/pay-1/manual-receipt/file', form(PNG))).status).toBe(401);
    expect((await post('/api/v1/payments/pay-1/manual-receipt/file', form(PNG), { Authorization: `Bearer ${customer('cust-2')}` })).status).toBe(404);
    assertNothingWritten();
  });

  it('generic admin upload: no auth -> 401, admin without Media.upload -> 403; nothing written', async () => {
    expect((await post('/api/v1/upload', form(PNG))).status).toBe(401);
    expect((await post('/api/v1/upload', form(PNG), adminCookie(staffToken))).status).toBe(403);
    assertNothingWritten();
  });

  it('authorised uploads are written: receipts PRIVATE, catalogue images public', async () => {
    const byToken = await post('/api/v1/payments/upload/good-token/file', form(PNG));
    expect(byToken.status).toBe(201);
    const tokenUrl: string = (await byToken.json()).url;
    expect(tokenUrl).toMatch(/^http:\/\/api\.example\.test\/api\/v1\/payments\/receipts\/\d+-[0-9a-f]{32}\.png$/);

    const byOwner = await post('/api/v1/payments/pay-1/manual-receipt/file', form(PNG), { Authorization: `Bearer ${customer('cust-1')}` });
    expect(byOwner.status).toBe(201);
    const ownerFile = String((await byOwner.json()).url).split('/').pop()!;
    RECEIPTS_OF_CUST_1.add(ownerFile);

    const image = await post('/api/v1/upload', form(PNG), adminCookie(superToken));
    expect(image.status).toBe(201);
    expect((await image.json()).url).toMatch(/\/uploads\/\d+-[0-9a-f]{32}\.png$/);

    const written = filesUnder(h.uploadRoot).map((f) => f.slice(h.uploadRoot.length));
    expect(written.filter((f) => f.startsWith('/private/receipts/'))).toHaveLength(2);
    expect(written.filter((f) => f.startsWith('/public/'))).toHaveLength(1);
  });

  it('receipts are not reachable through the public static route', async () => {
    const receipt = filesUnder(join(h.uploadRoot, 'private', 'receipts'))[0].split('/').pop();
    for (const path of [`/uploads/${receipt}`, `/uploads/private/receipts/${receipt}`, `/uploads/../private/receipts/${receipt}`, `/uploads/%2e%2e/private/receipts/${receipt}`]) {
      expect((await fetch(`${h.base}${path}`)).status).toBe(404);
    }
  });

  it('receipt download: anonymous 401, other customer 404, owner 200, admin with Payment.read 200, admin without 403', async () => {
    const file = [...RECEIPTS_OF_CUST_1][0];
    const url = `${h.base}/api/v1/payments/receipts/${file}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${customer('cust-2')}` } })).status).toBe(404);

    const owner = await fetch(url, { headers: { Authorization: `Bearer ${customer('cust-1')}` } });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('content-type')).toBe('image/png');
    expect(owner.headers.get('cache-control')).toMatch(/no-store/);
    expect(Buffer.from(await owner.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await fetch(url, { headers: { Cookie: `ms_admin_access=${bellToken}` } })).status).toBe(200); // Payment.read
    expect((await fetch(url, { headers: { Cookie: `ms_admin_access=${superToken}` } })).status).toBe(200);
    expect((await fetch(url, { headers: { Cookie: `ms_admin_access=${staffToken}` } })).status).toBe(403);
    expect((await fetch(`${h.base}/api/v1/payments/receipts/..%2F..%2Fetc%2Fpasswd`, { headers: { Cookie: `ms_admin_access=${superToken}` } })).status).toBe(404);
  });
});

// ============================================================================
describe('L5 CORS over HTTP', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => stopHarness(h));

  const preflight = (origin: string) =>
    fetch(`${h.base}/api/v1/admin/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' },
    });

  it.each([STOREFRONT, ADMIN_UI])('approved origin %s passes with credentials', async (origin) => {
    const res = await preflight(origin);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('a rejected origin gets a clean 403 (not 500) with no CORS grant and no internal detail', async () => {
    for (const res of [await preflight('https://evil.example'), await fetch(`${h.base}/api/v1/admin/auth/me`, { headers: { Origin: 'https://evil.example.test' } })]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(await res.json()).toEqual({ statusCode: 403, message: 'Origin not allowed' });
    }
  });

  it('requests without an Origin (server-to-server, curl) are unaffected', async () => {
    expect((await fetch(`${h.base}/api/v1/admin/auth/me`)).status).toBe(401); // reaches the route
  });
});
