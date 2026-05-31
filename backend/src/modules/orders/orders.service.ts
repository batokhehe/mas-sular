import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Promo, VoucherType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EventBus } from '../../infrastructure/events/event-bus';
import { CheckoutPaymentMethod, CreateOrderDto, ValidateVoucherDto } from './application/dto/create-order.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  private getDeliveryFee(subtotal: number) {
    return subtotal >= 100000 ? 0 : 10000;
  }

  private async findVoucherByCode(code: string) {
    const voucher = await this.prisma.promo.findFirst({ where: { code, deletedAt: null } });
    if (!voucher) throw new BadRequestException('Voucher code not found');
    return voucher;
  }

  private async assertVoucherAvailability(voucher: Promo, userId: string, subtotal: number) {
    const now = new Date();

    if (!voucher.isActive) {
      throw new BadRequestException('Voucher is not active');
    }

    if (voucher.startDate && now < voucher.startDate) {
      throw new BadRequestException('Voucher is not valid yet');
    }

    if (voucher.endDate && now > voucher.endDate) {
      throw new BadRequestException('Voucher has expired');
    }

    if (voucher.maxUsageCount !== null && voucher.currentUsageCount >= voucher.maxUsageCount) {
      throw new BadRequestException('Voucher usage limit has been reached');
    }

    if (voucher.minimumOrderAmount > 0 && subtotal < voucher.minimumOrderAmount) {
      throw new BadRequestException(`Minimum order amount is Rp ${voucher.minimumOrderAmount.toLocaleString('id-ID')}`);
    }

    if (voucher.isNewUserOnly) {
      const completedOrders = await this.prisma.order.count({
        where: { userId, status: OrderStatus.COMPLETED, deletedAt: null },
      });
      if (completedOrders > 0) {
        throw new BadRequestException('Voucher is only available for new customers');
      }
    }

    const existingUsage = await this.prisma.voucherUsage.findFirst({
      where: { voucherId: voucher.id, userId },
    });
    if (existingUsage) {
      throw new BadRequestException('This voucher has already been used by your account');
    }

    if (voucher.voucherType === VoucherType.FREE_SHIPPING && voucher.freeShippingMaxAmount !== null && voucher.freeShippingMaxAmount < 0) {
      throw new BadRequestException('Voucher shipping limit is invalid');
    }

    if (voucher.voucherType === VoucherType.PERCENTAGE_DISCOUNT && !voucher.discountPercentage) {
      throw new BadRequestException('Voucher configuration is invalid');
    }

    if (voucher.voucherType === VoucherType.FIXED_DISCOUNT && (!voucher.discountAmount || voucher.discountAmount <= 0)) {
      throw new BadRequestException('Voucher configuration is invalid');
    }
  }

  private calculateVoucherDiscount(voucher: Promo, subtotal: number, deliveryFee: number) {
    switch (voucher.voucherType) {
      case VoucherType.FREE_SHIPPING: {
        if (deliveryFee === 0) {
          return 0;
        }
        const maxAmount = voucher.freeShippingMaxAmount ?? deliveryFee;
        return Math.min(deliveryFee, maxAmount);
      }
      case VoucherType.PERCENTAGE_DISCOUNT: {
        const discount = Math.floor((subtotal * (voucher.discountPercentage ?? 0)) / 100);
        if (voucher.maxDiscountAmount !== null && voucher.maxDiscountAmount !== undefined) {
          return Math.min(discount, voucher.maxDiscountAmount);
        }
        return discount;
      }
      case VoucherType.FIXED_DISCOUNT: {
        return Math.min(voucher.discountAmount ?? 0, subtotal);
      }
      default:
        return 0;
    }
  }

  async previewVoucher(dto: ValidateVoucherDto) {
    const voucher = await this.findVoucherByCode(dto.code.trim().toUpperCase());
    await this.assertVoucherAvailability(voucher, dto.userId, dto.subtotal);
    const deliveryFee = this.getDeliveryFee(dto.subtotal);
    const discountAmount = this.calculateVoucherDiscount(voucher, dto.subtotal, deliveryFee);

    return {
      voucherId: voucher.id,
      voucherCode: voucher.code,
      voucherType: voucher.voucherType,
      discountAmount,
      deliveryFee,
      subtotal: dto.subtotal,
      total: dto.subtotal + deliveryFee - discountAmount,
    };
  }

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

    const deliveryFee = this.getDeliveryFee(subtotal);
    let voucher: Promo | null = null;
    let voucherDiscountAmount = 0;

    if (dto.promoCode) {
      voucher = await this.findVoucherByCode(dto.promoCode.trim().toUpperCase());
      await this.assertVoucherAvailability(voucher, dto.userId, subtotal);
      voucherDiscountAmount = this.calculateVoucherDiscount(voucher, subtotal, deliveryFee);
    }

    const totalPrice = subtotal + deliveryFee - voucherDiscountAmount;
    const orderNumber = `BN-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Date.now().toString().slice(-5)}`;

    const order = await this.prisma.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          userId: dto.userId,
          addressId: dto.addressId,
          paymentMethod: dto.paymentMethod as PaymentMethod,
          subtotal,
          deliveryFee,
          voucherDiscountAmount,
          totalPrice,
          voucherId: voucher?.id,
          voucherCode: voucher?.code,
          voucherType: voucher?.voucherType,
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
              status: dto.paymentMethod === CheckoutPaymentMethod.COD ? PaymentStatus.PENDING : PaymentStatus.WAITING_VERIFICATION,
            },
          },
          events: {
            create: {
              status: OrderStatus.PENDING,
              note: 'Order created',
            },
          },
        },
        include: { items: { include: { toppings: true } }, payment: true },
      });

      if (voucher) {
        const voucherUpdate = voucher.maxUsageCount !== null
          ? tx.promo.update({
              where: { id: voucher.id, currentUsageCount: { lt: voucher.maxUsageCount } },
              data: { currentUsageCount: { increment: 1 } },
            })
          : tx.promo.update({ where: { id: voucher.id }, data: { currentUsageCount: { increment: 1 } } });

        await voucherUpdate;

        await tx.voucherUsage.create({
          data: {
            voucherId: voucher.id,
            userId: dto.userId,
            orderId: createdOrder.id,
          },
        });
      }

      return createdOrder;
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
