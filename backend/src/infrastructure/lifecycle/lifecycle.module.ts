import { Module } from '@nestjs/common';
import { LIFECYCLE_CONFIG, loadLifecycleConfig } from './lifecycle.config';
import { LifecycleMetrics } from './lifecycle.metrics';
import { RetentionWorker } from './retention.worker';

@Module({
  providers: [
    { provide: LIFECYCLE_CONFIG, useFactory: () => loadLifecycleConfig() },
    LifecycleMetrics,
    RetentionWorker,
  ],
})
export class LifecycleModule {}
