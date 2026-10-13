import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../../src/modules/auth/auth.service';
import { generateRefreshToken, hashRefreshSecret } from '../../src/modules/auth/refresh-token.util';

function buildPrismaMock() {
  return {
    role: { findUnique: jest.fn() },
    user: { upsert: jest.fn(), findFirst: jest.fn() },
    refreshToken: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
}

function buildService(prisma: ReturnType<typeof buildPrismaMock>) {
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AuthService(prisma as any, jwt as any);
  return { service, jwt };
}

const CUSTOMER_ROLE = { id: 'role-customer', name: 'CUSTOMER' };

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'active@example.com',
    isActive: true,
    deletedAt: null,
    roles: [{ role: CUSTOMER_ROLE }],
    addresses: [],
    ...overrides,
  };
}

describe('AuthService account-status enforcement', () => {
  const originalClientId = process.env.GOOGLE_CLIENT_ID;

  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  });

  afterAll(() => {
    process.env.GOOGLE_CLIENT_ID = originalClientId;
  });

  describe('issueTokens', () => {
    it('issues tokens for an active user', async () => {
      const prisma = buildPrismaMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const tokens = await service.issueTokens('user-1', 'active@example.com', ['CUSTOMER']);

      expect(tokens.accessToken).toBe('signed-access-token');
      expect(typeof tokens.refreshToken).toBe('string');
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to issue tokens for a disabled user', async () => {
      const prisma = buildPrismaMock();
      prisma.user.findFirst.mockResolvedValue(null); // not active / soft-deleted
      const { service } = buildService(prisma);

      await expect(
        service.issueTokens('user-1', 'disabled@example.com', ['CUSTOMER']),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('loginWithGoogleProfile', () => {
    const profile = {
      googleId: 'g-1',
      email: 'active@example.com',
      name: 'Active User',
    };

    it('logs in an active user and returns tokens', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser());
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const result = await service.loginWithGoogleProfile(profile);

      expect(result.user.id).toBe('user-1');
      expect(result.tokens.accessToken).toBe('signed-access-token');
    });

    it('rejects Google login for a deactivated user', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser({ isActive: false }));
      const { service } = buildService(prisma);

      await expect(service.loginWithGoogleProfile(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // never reaches token issuance
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects Google login for a soft-deleted user', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser({ deletedAt: new Date() }));
      const { service } = buildService(prisma);

      await expect(service.loginWithGoogleProfile(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('rotateRefreshToken', () => {
    // H2: a presented token is `<selector>.<secret>`; the row stores SHA-256(secret).
    const issued = generateRefreshToken();
    const presentedToken = issued.token;

    function tokenRecord(userOverrides: Record<string, unknown> = {}, rowOverrides: Record<string, unknown> = {}) {
      return {
        id: 'rt-1',
        userId: 'user-1',
        selector: issued.selector,
        tokenHash: issued.verifierHash,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          email: 'active@example.com',
          isActive: true,
          deletedAt: null,
          roles: [{ role: CUSTOMER_ROLE }],
          ...userOverrides,
        },
        ...rowOverrides,
      };
    }

    it('rotates the token for an active user', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const tokens = await service.rotateRefreshToken(presentedToken);

      expect(tokens.accessToken).toBe('signed-access-token');
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { selector: issued.selector } }),
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      }); // old token revoked, only if still active
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1); // new token issued
      expect(tokens.refreshToken).not.toBe(presentedToken);
    });

    it('rejects rotation for a disabled user and revokes the presented token', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord({ isActive: false }));
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const { service } = buildService(prisma);

      await expect(service.rotateRefreshToken(presentedToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1); // token still revoked
      expect(prisma.refreshToken.create).not.toHaveBeenCalled(); // no new token
    });

    it('rejects a wrong secret for a real selector', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord());
      const { service } = buildService(prisma);

      await expect(service.rotateRefreshToken(`${issued.selector}.${'0'.repeat(64)}`)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects malformed and legacy (pre-H2 UUID) tokens without touching the database', async () => {
      const prisma = buildPrismaMock();
      const { service } = buildService(prisma);

      for (const bad of ['wrong-token', '6f1c2a5e-8f9b-4c3d-9e2a-1b2c3d4e5f60', `${issued.selector}.short`, '']) {
        await expect(service.rotateRefreshToken(bad)).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
      expect(prisma.refreshToken.findMany).not.toHaveBeenCalled(); // no scan, ever
    });

    it('rejects revoked and expired rows', async () => {
      for (const row of [{ revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1) }]) {
        const prisma = buildPrismaMock();
        prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord({}, row));
        const { service } = buildService(prisma);
        await expect(service.rotateRefreshToken(presentedToken)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      }
    });

    it('loses the race cleanly when a concurrent refresh already consumed the token', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 }); // someone else revoked it first
      const { service } = buildService(prisma);

      await expect(service.rotateRefreshToken(presentedToken)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('never runs bcrypt on the refresh path', async () => {
      const compareSync = jest.spyOn(bcrypt, 'compareSync');
      const compare = jest.spyOn(bcrypt, 'compare');
      const hash = jest.spyOn(bcrypt, 'hash');
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(tokenRecord());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      await service.rotateRefreshToken(presentedToken);
      await service.rotateRefreshToken('bogus').catch(() => undefined);
      await service.revokeRefreshToken(presentedToken);

      expect(compareSync).not.toHaveBeenCalled();
      expect(compare).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });
  });

  describe('issueTokens refresh token format (H2)', () => {
    it('stores only the selector and SHA-256 of the secret, never the token', async () => {
      const prisma = buildPrismaMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const { refreshToken } = await service.issueTokens('user-1', 'active@example.com', ['CUSTOMER']);

      expect(refreshToken).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
      const [selector, secret] = refreshToken.split('.');
      const data = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(data.selector).toBe(selector);
      expect(data.tokenHash).toBe(hashRefreshSecret(secret));
      expect(JSON.stringify(data)).not.toContain(secret);
    });
  });

  describe('revokeRefreshToken', () => {
    it('revokes only the presented, still-active row and is a no-op for anything else', async () => {
      const issued = generateRefreshToken();
      const prisma = buildPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-9', selector: issued.selector, tokenHash: issued.verifierHash, revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000), user: { roles: [] },
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const { service } = buildService(prisma);

      await service.revokeRefreshToken(issued.token);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { id: 'rt-9', revokedAt: null }, data: { revokedAt: expect.any(Date) } });

      prisma.refreshToken.updateMany.mockClear();
      await service.revokeRefreshToken('not-a-token');
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
