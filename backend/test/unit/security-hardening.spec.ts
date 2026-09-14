import { BadRequestException, ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuthService } from '../../src/modules/auth/auth.service';
import { MetricsAccessGuard } from '../../src/infrastructure/metrics/metrics-access.guard';
import { ShippingController } from '../../src/modules/shipping/presentation/shipping.controller';
import { ShippingRateDto } from '../../src/modules/shipping/application/dto/shipping.dto';
import { AdminGuard } from '../../src/common/guards/admin.guard';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { adminAccessTtlToMs, loadAdminSessionConfig } from '../../src/modules/admin-auth/admin-session.config';
import { RejectUrlCredentialsGuard } from '../../src/common/guards/reject-url-credentials.guard';

// ============================================================ M5 Google =====

describe('M5: Google sign-in requires email_verified === true', () => {
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  });
  afterAll(() => {
    process.env.GOOGLE_CLIENT_ID = originalClientId;
  });

  function build(payload: Record<string, unknown>) {
    const prisma = {
      role: { findUnique: jest.fn().mockResolvedValue({ id: 'role-customer', name: 'CUSTOMER' }) },
      user: {
        upsert: jest.fn().mockResolvedValue({ id: 'user-1', email: payload.email, isActive: true, deletedAt: null, roles: [{ role: { name: 'CUSTOMER' } }], addresses: [] }),
        findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      refreshToken: { create: jest.fn() },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AuthService(prisma as any, { signAsync: jest.fn().mockResolvedValue('t') } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).googleClient = { verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => payload }) };
    return { service, prisma };
  }

  const base = { email: 'victim@example.com', sub: 'google-sub-1', name: 'Victim' };

  it.each([
    ['false', false],
    ['missing', undefined],
    ['the string "true"', 'true'],
  ])('rejects email_verified %s without touching the user table', async (_label, value) => {
    const { service, prisma } = build({ ...base, ...(value === undefined ? {} : { email_verified: value }) });
    await expect(service.loginWithGoogleIdToken('id-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('accepts a verified Google email (unchanged flow)', async () => {
    const { service, prisma } = build({ ...base, email_verified: true });
    const result = await service.loginWithGoogleIdToken('id-token');
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    expect(result.tokens.accessToken).toBe('t');
  });
});

// ============================================================= M1 metrics ===

describe('M1: /metrics is internal-only', () => {
  const ctx = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;
  const guard = new MetricsAccessGuard();
  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it('a direct in-network scrape (no proxy headers) is served', () => {
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it.each<Record<string, string>>([{ 'x-forwarded-for': '203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }])('a request through the public proxy (%p) gets 404', (headers) => {
    expect(() => guard.canActivate(ctx(headers))).toThrow(NotFoundException);
  });

  it('METRICS_TOKEN lets an authorised scraper through the proxy; a wrong token does not', () => {
    process.env.METRICS_TOKEN = 'm'.repeat(40);
    expect(guard.canActivate(ctx({ 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${'m'.repeat(40)}` }))).toBe(true);
    expect(() => guard.canActivate(ctx({ 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${'x'.repeat(40)}` }))).toThrow(NotFoundException);
  });
});

// ========================================================= M3 shipping ======

describe('M3: courier lookup endpoints are no longer public', () => {
  it('both routes require an admin session and Shipment.read, with a per-route throttle', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ShippingController)).toEqual([AdminGuard, PermissionGuard]);
    for (const handler of ['rates', 'track'] as const) {
      const fn = ShippingController.prototype[handler];
      expect(Reflect.getMetadata(PERMISSIONS_KEY, fn)).toEqual(['Shipment.read']);
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(20);
    }
  });

  it('tracking validates the provider and the AWB before any provider call', () => {
    const shipping = { track: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = new ShippingController(shipping as any);
    expect(() => controller.track('fedex', 'AB123456')).toThrow(BadRequestException);
    expect(() => controller.track('jne', '../../etc')).toThrow(BadRequestException);
    expect(() => controller.track('jne', 'x'.repeat(41))).toThrow(BadRequestException);
    expect(shipping.track).not.toHaveBeenCalled();
    void controller.track('JNE', 'CGK1234567890');
    expect(shipping.track).toHaveBeenCalledWith('jne', 'CGK1234567890');
  });

  it('rate quotes validate postal codes and weight', () => {
    const errors = (o: object) => validateSync(plainToInstance(ShippingRateDto, o)).map((e) => e.property);
    expect(errors({ originPostalCode: '40286', destinationPostalCode: '12345', weightGram: 1000 })).toEqual([]);
    expect(errors({ originPostalCode: 'abc', destinationPostalCode: '1234567', weightGram: 999_999 })).toEqual(['originPostalCode', 'destinationPostalCode', 'weightGram']);
  });
});

// ================================================== H4 admin TTL config =====

describe('H4: admin access TTL is hours, never days', () => {
  it.each([['8h', 8 * 3_600_000], ['90m', 90 * 60_000], ['12h', 12 * 3_600_000], ['3600s', 3_600_000]])('accepts %s', (v, ms) => {
    expect(adminAccessTtlToMs(v)).toBe(ms);
  });

  it.each(['6d', '1d', '13h', '0h', '7d', 'forever', '', '1w'])('rejects %s', (v) => {
    expect(adminAccessTtlToMs(v)).toBeNull();
  });

  it('defaults to 8h and refuses to load a long-lived value', () => {
    expect(loadAdminSessionConfig({}).ttl).toBe('8h');
    expect(() => loadAdminSessionConfig({ JWT_ADMIN_ACCESS_TTL: '6d' })).toThrow(/at most 12h/);
  });
});

// ===================================================== H2 URL credentials ===

describe('H2: RejectUrlCredentialsGuard', () => {
  const ctx = (query: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ query }) }) }) as unknown as ExecutionContext;
  const guard = new RejectUrlCredentialsGuard();

  it.each(['token', 'TOKEN', 'access_token', 'accessToken', 'refresh_token', 'jwt', 'auth', 'authorization', 'sid', 'session'])('refuses ?%s=', (key) => {
    expect(() => guard.canActivate(ctx({ [key]: 'x' }))).toThrow(UnauthorizedException);
  });

  it('allows ordinary query parameters', () => {
    expect(guard.canActivate(ctx({ cursor: 'abc', limit: '20', category: 'orders' }))).toBe(true);
  });
});
