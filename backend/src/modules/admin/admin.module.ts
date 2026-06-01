import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AdminCmsController } from './presentation/admin-cms.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminOperationsController } from './presentation/admin-operations.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminCatalogController, AdminCmsController, AdminOperationsController],
  providers: [AdminService, PermissionGuard],
  exports: [AdminService],
})
export class AdminModule {}
