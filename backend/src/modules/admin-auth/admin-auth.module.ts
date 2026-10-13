import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { StringValue } from 'ms';
import { AdminAuthController } from './presentation/admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtStrategy } from './infrastructure/admin-jwt.strategy';
import { AdminLoginLimiter } from './admin-login-limiter';
import { loadAdminSessionConfig } from './admin-session.config';
import { AdminSessionStore } from './admin-session.store';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('jwt.adminAccessSecret');
        if (!secret) throw new Error('JWT_ADMIN_ACCESS_SECRET is not configured'); // no insecure fallback
        return {
          secret,
          signOptions: { expiresIn: loadAdminSessionConfig().ttl as StringValue, algorithm: 'HS256' },
          verifyOptions: { algorithms: ['HS256'] },
        };
      },
    }),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminSessionStore, AdminLoginLimiter],
  exports: [AdminAuthService, AdminSessionStore],
})
export class AdminAuthModule {}
