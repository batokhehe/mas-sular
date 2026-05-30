import { Controller, Get, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ApiTags } from '@nestjs/swagger';
import { Cache } from 'cache-manager';
import amqp from 'amqplib';
import { PrismaService } from './database/prisma.service';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  @Get()
  health() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.mysql = 'ok';
    } catch (error) {
      checks.mysql = 'failed';
    }

    try {
      await this.cacheManager.set('health-check', 'ok', 5);
      const value = await this.cacheManager.get<string>('health-check');
      checks.redis = value === 'ok' ? 'ok' : 'failed';
    } catch (error) {
      checks.redis = 'failed';
    }

    if (process.env.RABBITMQ_URL) {
      try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        await connection.close();
        checks.rabbitmq = 'ok';
      } catch (error) {
        checks.rabbitmq = 'failed';
      }
    } else {
      checks.rabbitmq = 'skipped';
    }

    const status = Object.values(checks).every((value) => value === 'ok' || value === 'skipped') ? 'ready' : 'not_ready';
    return { status, checks };
  }

  @Get('live')
  live() {
    return { status: 'live' };
  }
}
