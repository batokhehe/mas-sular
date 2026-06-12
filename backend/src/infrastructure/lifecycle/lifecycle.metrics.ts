import { Injectable, Logger } from '@nestjs/common';

/** Telemetry for retention sweeps. Structured log lines; a metrics backend can hook later. */
@Injectable()
export class LifecycleMetrics {
  private readonly logger = new Logger('LifecycleRetention');

  swept(fields: { table: string; wouldDeleteCount: number; deletedCount: number; durationMs: number; dryRun: boolean }): void {
    this.logger.log({ metric: 'retention.swept', ...fields });
  }
}
