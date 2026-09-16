import { Global, Module } from '@nestjs/common';
import { INTEGRATION_LOG_CONFIG, loadIntegrationLogConfig } from './integration-log.config';
import { IntegrationLogQueryService } from './integration-log-query.service';
import { IntegrationLogService } from './integration-log.service';

/**
 * Integration API logging (additive, global - same shape as LoggingModule, so any
 * provider or webhook service can inject the recorder without an explicit import).
 * Nothing here participates in business flow: the recorder is fire-and-forget and
 * the query service is read-only.
 */
@Global()
@Module({
  providers: [
    { provide: INTEGRATION_LOG_CONFIG, useFactory: () => loadIntegrationLogConfig() },
    IntegrationLogService,
    IntegrationLogQueryService,
  ],
  exports: [IntegrationLogService, IntegrationLogQueryService],
})
export class IntegrationLogModule {}
