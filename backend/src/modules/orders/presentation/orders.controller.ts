import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateOrderDto } from '../application/dto/create-order.dto';
import { OrdersService } from '../orders.service';

@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('checkout')
  checkout(@Body() dto: CreateOrderDto) {
    return this.orders.checkout(dto);
  }

  @Get('users/:userId')
  listForUser(@Param('userId') userId: string, @Query('status') status?: string) {
    return this.orders.listForUser(userId, status);
  }
}
