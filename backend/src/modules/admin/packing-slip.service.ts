import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PACKING_SLIP_SELECT, PackingSlipView, toPackingSlipView } from './packing-slip';

/**
 * P3 Packing Slip. READ-ONLY by construction: one findUnique with a narrow select,
 * then a pure mapping. No writes, no shipment/payment services, no provider calls,
 * and nothing about the order is logged.
 */
@Injectable()
export class PackingSlipService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orderId: string): Promise<PackingSlipView> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: PACKING_SLIP_SELECT });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    return toPackingSlipView(order);
  }
}
