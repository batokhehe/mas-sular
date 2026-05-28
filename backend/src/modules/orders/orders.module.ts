import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './presentation/orders.controller';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
