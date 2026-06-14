import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { PaymentUploadModule } from './payment-upload.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './presentation/payments.controller';

@Module({
  imports: [PaymentUploadModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PermissionGuard],
})
export class PaymentsModule {}
