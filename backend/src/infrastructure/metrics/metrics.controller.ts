import { Controller, Get, Header, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { MetricsAccessGuard } from './metrics-access.guard';
import { MetricsRegistry } from './metrics.registry';

/**
 * Prometheus scrape endpoint. Version-neutral and excluded from the global API
 * prefix in main.ts so it is served at GET /metrics. Internal-only (M1): see
 * MetricsAccessGuard - direct in-network scrapes (or METRICS_TOKEN) only.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
@UseGuards(MetricsAccessGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.expose();
  }
}
