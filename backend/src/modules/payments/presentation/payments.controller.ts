import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { UploadManualPaymentDto } from '../application/dto/payment.dto';
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

  // NOTE: payment verification is admin-only and lives on the admin surface
  // (PATCH /admin/payments/:paymentId/verify), which binds the verifier to the
  // authenticated admin principal. The previous customer-surface verify endpoint
  // that trusted an adminUserId from the request body has been removed.
}
