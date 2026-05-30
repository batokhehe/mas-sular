import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { StringValue } from 'ms';
import { randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AuthService {
  private readonly googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async loginWithGoogleIdToken(idToken: string) {
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub || !payload.name) {
      throw new UnauthorizedException('Invalid Google profile');
    }
    return this.loginWithGoogleProfile({
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
    });
  }

  async loginWithGoogleProfile(profile: { googleId: string; email: string; name: string; avatarUrl?: string }) {
    const customerRole = await this.prisma.role.findUniqueOrThrow({ where: { name: 'CUSTOMER' } });
    const user = await this.prisma.user.upsert({
      where: { email: profile.email },
      update: { googleId: profile.googleId, name: profile.name, avatarUrl: profile.avatarUrl },
      create: {
        googleId: profile.googleId,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        roles: { create: { roleId: customerRole.id } },
      },
      include: { roles: { include: { role: true } } },
    });
    return this.issueTokens(user.id, user.email, user.roles.map((r) => r.role.name));
  }

  async issueTokens(userId: string, email: string, roles: string[]) {
    const familyId = randomUUID();
    const expiresIn = (process.env.JWT_ACCESS_TTL ?? '15m') as StringValue;
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, roles },
      { expiresIn },
    );
    const refreshToken = randomUUID();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: await bcrypt.hash(refreshToken, 12),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken };
  }

  async rotateRefreshToken(refreshToken: string) {
    const candidates = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: { include: { roles: { include: { role: true } } } } },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const record = candidates.find((token) => bcrypt.compareSync(refreshToken, token.tokenHash));
    if (!record) throw new UnauthorizedException('Invalid refresh token');
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(record.userId, record.user.email, record.user.roles.map((r) => r.role.name));
  }
}
