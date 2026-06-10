import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  createOrder(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.orders.checkout(user.sub, dto);
  }
}
