import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { IntegrationLogQueryService } from '../../../infrastructure/integration-log/integration-log-query.service';
import { ListIntegrationLogsQueryDto } from '../application/dto/integration-log-query.dto';

/**
 * External API call log (Paxel / JNE / Midtrans) — read-only search + detail.
 * Gated by the dedicated `IntegrationLog.read` permission, which no role holds in
 * the matrix: SUPER_ADMIN only, the same treatment `SystemLog.read` gets.
 *
 * Nothing is redacted here because nothing needs to be: rows are sanitized before
 * they are written (integration-log.sanitizer.ts), so this endpoint cannot widen
 * what was persisted. Always paginated.
 */
@ApiTags('admin-integration-logs')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/integration-logs', version: '1' })
export class AdminIntegrationLogController {
  constructor(private readonly logs: IntegrationLogQueryService) {}

  @Permissions('IntegrationLog.read')
  @Get()
  list(@Query() query: ListIntegrationLogsQueryDto) {
    return this.logs.list(query);
  }

  /** Every record of ONE logical call: each HTTP attempt plus its application outcome. */
  @Permissions('IntegrationLog.read')
  @Get('operations/:operationId')
  byOperation(@Param('operationId') operationId: string) {
    return this.logs.byOperation(operationId);
  }

  @Permissions('IntegrationLog.read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.logs.get(id);
  }
}
