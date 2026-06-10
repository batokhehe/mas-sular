import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module';
import { OrdersService } from './orders.service';
import { CheckoutController } from './presentation/checkout.controller';
import { OrdersController } from './presentation/orders.controller';

@Module({
  imports: [ShippingModule],
  controllers: [OrdersController, CheckoutController],
  providers: [OrdersService],
})
export class OrdersModule {}
