import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CreateOrderDto, ValidateVoucherDto } from '../application/dto/create-order.dto';
import { OrdersService } from '../orders.service';

@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.orders.checkout(user.sub, dto);
  }

  @Post('voucher/preview')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  previewVoucher(@CurrentUser() user: AuthUser, @Body() dto: ValidateVoucherDto) {
    return this.orders.previewVoucher(user.sub, dto);
  }

  @Get('users/:userId')
  listForUser(@Param('userId') userId: string, @Query('status') status?: string) {
    return this.orders.listForUser(userId, status);
  }
}
