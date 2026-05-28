import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EventBus } from '../../infrastructure/events/event-bus';
import { CreateOrderDto } from './application/dto/create-order.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async checkout(dto: CreateOrderDto) {
    const productIds = dto.items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
    if (products.length !== productIds.length) throw new BadRequestException('Some products are unavailable');

    const toppings = await this.prisma.topping.findMany({
      where: { id: { in: dto.items.flatMap((item) => item.toppingIds ?? []) }, deletedAt: null },
    });

    const subtotal = dto.items.reduce((sum, item) => {
      const product = products.find((p) => p.id === item.productId)!;
      const toppingTotal = (item.toppingIds ?? []).reduce((inner, id) => inner + (toppings.find((t) => t.id === id)?.price ?? 0), 0);
      return sum + (product.price + toppingTotal) * item.quantity;
    }, 0);
    const deliveryFee = subtotal >= 100000 ? 0 : 10000;
    const discountTotal = dto.promoCode ? Math.round(subtotal * 0.1) : 0;
    const totalPrice = subtotal + deliveryFee - discountTotal;
    const orderNumber = `BN-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Date.now().toString().slice(-5)}`;

    const order = await this.prisma.order.create({
      data: {
        orderNumber,
        userId: dto.userId,
        addressId: dto.addressId,
        paymentMethod: dto.paymentMethod as PaymentMethod,
        subtotal,
        deliveryFee,
        discountTotal,
        totalPrice,
        items: {
          create: dto.items.map((item) => {
            const product = products.find((p) => p.id === item.productId)!;
            return {
              productId: product.id,
              productName: product.name,
              unitPrice: product.price,
              quantity: item.quantity,
              spicyLevel: item.spicyLevel,
              notes: item.notes,
              toppings: {
                create: (item.toppingIds ?? []).map((id) => {
                  const topping = toppings.find((t) => t.id === id)!;
                  return { toppingId: id, name: topping.name, price: topping.price };
                }),
              },
            };
          }),
        },
        payment: {
          create: {
            method: dto.paymentMethod as PaymentMethod,
            amount: totalPrice,
            status: dto.paymentMethod === 'COD' ? 'PENDING' : 'WAITING_VERIFICATION',
          },
        },
        events: { create: { status: 'PENDING', note: 'Order created' } },
      },
      include: { items: { include: { toppings: true } }, payment: true },
    });

    await this.eventBus.publish('orders', 'order.created', {
      id: order.id,
      name: 'order.created',
      occurredAt: new Date(),
      payload: { orderId: order.id, orderNumber: order.orderNumber, totalPrice: order.totalPrice },
    });
    return order;
  }

  listForUser(userId: string, status?: string) {
    return this.prisma.order.findMany({
      where: { userId, deletedAt: null, status: status as never },
      include: { items: { include: { toppings: true } }, address: true, payment: true, shipment: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
