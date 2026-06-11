import { Body, ConflictException, Controller, Headers, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CheckoutSummaryDto, CreateOrderDto, ShippingCostDto, ValidateVoucherDto } from '../application/dto/create-order.dto';
import { OrdersService } from '../orders.service';

@ApiTags('checkout')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'checkout', version: '1' })
export class CheckoutController {
  constructor(private readonly orders: OrdersService) {}

  @Post('shipping-cost')
  shippingCost(@CurrentUser() user: AuthUser, @Body() dto: ShippingCostDto) {
    return this.orders.calculateShippingCost(user.sub, dto);
  }

  @Post('validate-voucher')
  validateVoucher(@CurrentUser() user: AuthUser, @Body() dto: ValidateVoucherDto) {
    return this.orders.previewVoucher(user.sub, dto);
  }

  @Post('summary')
  summary(@CurrentUser() user: AuthUser, @Body() dto: CheckoutSummaryDto) {
    return this.orders.getSummary(user.sub, dto);
  }

  @Post('order')
  async createOrder(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const idem = idempotencyKey
      ? { key: idempotencyKey, method: 'POST', endpoint: '/checkout/order' }
      : undefined;

    const outcome = await this.orders.checkout(user.sub, dto, idem);

    if (outcome.kind === 'processing') {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new ConflictException('Checkout already in progress for this Idempotency-Key');
    }

    if (outcome.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    res.status(outcome.statusCode);
    return outcome.body;
  }
}
