import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './presentation/payments.controller';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PermissionGuard],
})
export class PaymentsModule {}
