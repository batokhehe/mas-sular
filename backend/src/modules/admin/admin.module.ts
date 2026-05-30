import { Module } from '@nestjs/common';
import { AdminCmsController } from './presentation/admin-cms.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminOperationsController } from './presentation/admin-operations.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminCatalogController, AdminCmsController, AdminOperationsController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
