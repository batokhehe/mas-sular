import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { InvoiceTokenService } from './invoice-token.service';
import { CustomerInvoice, INVOICE_ORDER_SELECT, toCustomerInvoice } from './invoice-view';

/** One message for every failure, so a guess learns nothing about which orders or tokens exist. */
export const INVOICE_LINK_UNAVAILABLE = 'Invoice link is invalid or has expired';

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: InvoiceTokenService,
  ) {}

  /**
   * Public (no login) invoice for a tokenized link. The order is resolved ONLY
   * from the token - the request carries no order id to swap - and any
   * malformed/unknown/revoked/expired token or deleted order is the same 404.
   */
  async getByToken(rawToken: string): Promise<CustomerInvoice> {
    const orderId = await this.tokens.resolveOrderId(rawToken);
    if (!orderId) throw new NotFoundException(INVOICE_LINK_UNAVAILABLE);
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: INVOICE_ORDER_SELECT });
    if (!order || order.deletedAt) throw new NotFoundException(INVOICE_LINK_UNAVAILABLE);
    return toCustomerInvoice(order);
  }
}
