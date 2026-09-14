import { Controller, Get, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ApiTags } from '@nestjs/swagger';
import { Cache } from 'cache-manager';
import type { Response } from 'express';
import { PrismaService } from './database/prisma.service';
import { RabbitConnectionManager } from './infrastructure/outbox/rabbit-connection.manager';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly rabbit: RabbitConnectionManager,
  ) { }

  @Get()
  health() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (error) {
      checks.postgres = 'failed';
    }

    try {
      await this.cacheManager.set('health-check', 'ok');
      const value = await this.cacheManager.get<string>('health-check');
      checks.redis = value === 'ok' ? 'ok' : 'failed';
    } catch (error) {
      this.logger.error(`Redis readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      checks.redis = 'failed';
    }

    // RabbitMQ is required whenever the relay or consumers are enabled. When it is
    // required but unreachable (or unset), readiness fails — we never report ready
    // while the async infrastructure is broken. When not required, it is skipped.
    const rabbitRequired =
      process.env.OUTBOX_RELAY_ENABLED === 'true' || process.env.CONSUMERS_ENABLED === 'true';
    if (process.env.RABBITMQ_URL) {
      // L4: probe the SHARED connection the relay/consumers use - never a fresh
      // AMQP connection per request (the former per-call connect/close was a
      // public, unauthenticated way to make the API open broker connections).
      const healthy = await this.rabbit.isHealthy();
      checks.rabbitmq = healthy ? 'ok' : 'failed';
      if (!healthy) this.logger.warn('RabbitMQ readiness failed (shared connection unavailable)');
    } else {
      checks.rabbitmq = rabbitRequired ? 'failed' : 'skipped';
    }

    const ready = Object.values(checks).every((value) => value === 'ok' || value === 'skipped');

    // The status CODE is the readiness signal, not just the body. Proxies,
    // orchestrators and load balancers route on the code and never parse the
    // JSON; this endpoint used to answer 200 while reporting `not_ready`, so
    // any such consumer would happily send traffic to an API whose database
    // was down.
    //
    // Set on the response rather than thrown: ServiceUnavailableException is
    // caught by AllExceptionsFilter, which rewrites the body to
    // {statusCode,message,path,timestamp} and would discard the per-dependency
    // `checks` detail that operators and the recovery runbook read. With
    // `passthrough` Nest still serialises the object returned below, so the
    // response body is byte-for-byte what it was before.
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  @Get('live')
  live() {
    return { status: 'live' };
  }
}
