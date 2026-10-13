import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
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
 * List and operation routes return the sanitized columns only. The detail route
 * (GET :id) also returns the exchange EXACTLY as captured - request URL, request
 * body and response body with no redaction or masking - because the detail view must
 * show what was actually exchanged with the provider. Those values include provider
 * credentials and personal data: never add these columns to any other API.
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

  /** Detail: includes rawEndpoint / rawRequestBody / rawResponseBody verbatim. Never cached. */
  @Permissions('IntegrationLog.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string) {
    return this.logs.get(id);
  }
}
