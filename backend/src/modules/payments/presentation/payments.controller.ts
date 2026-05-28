import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UploadManualPaymentDto, VerifyPaymentDto } from '../application/dto/payment.dto';
import { PaymentsService } from '../payments.service';

@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':paymentId/manual-receipt')
  uploadManualReceipt(@Param('paymentId') paymentId: string, @Body() dto: UploadManualPaymentDto) {
    return this.payments.uploadManualReceipt(paymentId, dto);
  }

  @Patch(':paymentId/verify')
  verify(@Param('paymentId') paymentId: string, @Body() dto: VerifyPaymentDto) {
    return this.payments.verify(paymentId, dto);
  }
}
