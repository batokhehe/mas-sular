import { BadRequestException, Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { JneDestinationDiagnostics } from '../../shipping/infrastructure/jne-destination.diagnostics';

const DISTRICT_CODE = /^\d{2}\.\d{2}\.\d{2}$/;

/**
 * Why JNE is (not) quoted for a district, and where its mapping came from. Read-only;
 * behind the existing Shipment.read permission, so no new RBAC grant is needed.
 */
@ApiTags('admin-jne-destinations')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/shipping/jne-destinations', version: '1' })
export class AdminJneDestinationController {
  constructor(private readonly diagnostics: JneDestinationDiagnostics) {}

  @Permissions('Shipment.read')
  @Get(':districtCode')
  @Header('Cache-Control', 'no-store')
  get(@Param('districtCode') districtCode: string) {
    if (!DISTRICT_CODE.test(districtCode)) throw new BadRequestException('districtCode must look like 32.04.08');
    return this.diagnostics.forDistrictCode(districtCode);
  }
}
