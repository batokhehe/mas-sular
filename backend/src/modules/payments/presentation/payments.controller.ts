import { Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { UploadManualPaymentDto, VerifyPaymentDto } from '../application/dto/payment.dto';
import { PaymentsService } from '../payments.service';

@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':paymentId/manual-receipt')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  uploadManualReceipt(@Param('paymentId') paymentId: string, @Body() dto: UploadManualPaymentDto) {
    return this.payments.uploadManualReceipt(paymentId, dto);
  }

  @Patch(':paymentId/verify')
  @ApiBearerAuth()
  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Payment.verify')
  verify(@Param('paymentId') paymentId: string, @Body() dto: VerifyPaymentDto) {
    return this.payments.verify(paymentId, dto);
  }
}
