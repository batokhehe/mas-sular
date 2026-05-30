import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { StringValue } from 'ms';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = await this.issueAccessToken(admin.id, admin.email, admin.name, admin.isActive);
    return { accessToken };
  }

  async issueAccessToken(id: string, email: string, name: string, isActive: boolean) {
    const expiresIn = (process.env.JWT_ADMIN_ACCESS_TTL ?? '15m') as StringValue;
    return this.jwt.signAsync({ sub: id, email, name, isActive }, { expiresIn });
  }
}
