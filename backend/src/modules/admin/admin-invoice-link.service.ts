import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { InvoiceTokenService } from '../invoices/invoice-token.service';
import { CustomerCommunicationService } from './customer-communication.service';

type Admin = { id: string; name: string };

/** Customer-facing WhatsApp text. The link is the only secret it carries. */
export function invoiceWhatsAppMessage(input: { customerName: string; orderNumber: string; invoiceUrl: string; expiresAt: Date }): string {
  const until = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'Asia/Jakarta' }).format(input.expiresAt);
  return [
    `Halo ${input.customerName}, berikut invoice untuk pesanan ${input.orderNumber} di Bakso Mas Sular:`,
    input.invoiceUrl,
    `Link ini bisa dibuka dan dicetak sampai ${until}. Terima kasih!`,
  ].join('\n');
}

/**
 * P2 #14: Admin Order Detail -> customer invoice link.
 *
 * Every issue creates a fresh link and then revokes the order's older ones, so an
 * order has at most one working link. The raw link is returned to the admin only
 * in the response to the action that created it (under `invoiceUrl`, which the
 * audit trail strips); it cannot be read back later.
 *
 * WhatsApp goes through the EXISTING Customer Communication Center send (outbox
 * -> sender worker -> delivery gate -> Qontak). "Success" means the message was
 * accepted into that queue, never that WhatsApp delivered it.
 */
@Injectable()
export class AdminInvoiceLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: InvoiceTokenService,
    private readonly communication: CustomerCommunicationService,
  ) {}

  private async order(orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        userId: true,
        address: { select: { recipientName: true, phone: true } },
        user: { select: { name: true, phone: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Metadata of the active link (never the link itself - only its hash is stored). */
  async status(orderId: string) {
    await this.order(orderId);
    const active = await this.tokens.activeLink(orderId);
    return { active: active ? { createdAt: active.createdAt.toISOString(), expiresAt: active.expiresAt.toISOString() } : null };
  }

  /** New link for copy / open / print. Earlier links stop working. */
  async create(orderId: string, admin: Admin) {
    await this.order(orderId);
    const issued = await this.tokens.issue(orderId, admin.id);
    await this.tokens.revokeOthers(orderId, issued.id);
    return { invoiceUrl: issued.invoiceUrl, createdAt: issued.createdAt.toISOString(), expiresAt: issued.expiresAt.toISOString() };
  }

  /**
   * New link, sent to the order's delivery WhatsApp number. The older links are
   * revoked only AFTER the message was accepted, so a refused send leaves the
   * customer's current link working and throws away the unsent one.
   */
  async sendWhatsApp(orderId: string, admin: Admin) {
    const order = await this.order(orderId);
    const recipient = order.address?.phone || order.user?.phone;
    if (!recipient) throw new BadRequestException('This order has no WhatsApp number to send the invoice to');

    const issued = await this.tokens.issue(orderId, admin.id);
    let queued: { id: string; status: string; createdAt: string };
    try {
      queued = await this.communication.send(admin, {
        channel: NotificationChannel.WHATSAPP,
        recipient,
        template: 'manual.order-update',
        message: invoiceWhatsAppMessage({
          customerName: order.address?.recipientName || order.user?.name || 'Pelanggan',
          orderNumber: order.orderNumber,
          invoiceUrl: issued.invoiceUrl,
          expiresAt: issued.expiresAt,
        }),
        customerName: order.address?.recipientName || order.user?.name || undefined,
        customerId: order.userId,
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
    } catch (err) {
      await this.tokens.discard(issued.id);
      throw err;
    }
    await this.tokens.revokeOthers(orderId, issued.id);
    return {
      invoiceUrl: issued.invoiceUrl,
      createdAt: issued.createdAt.toISOString(),
      expiresAt: issued.expiresAt.toISOString(),
      notification: { id: queued.id, status: queued.status, createdAt: queued.createdAt },
    };
  }
}
