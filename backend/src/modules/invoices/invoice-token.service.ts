import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

/**
 * P2 #14 invoice-link policy:
 *  - a link is valid for 30 days from issue (long enough for the customer to keep
 *    and re-open it around delivery; the 72h upload-token window is for paying);
 *  - it is NOT single-use: the customer may open and print it repeatedly;
 *  - an order has at most ONE active link: issuing a new one revokes the others,
 *    so re-sending an invoice kills every earlier link;
 *  - a soft-deleted order's links stop working (checked by InvoiceService).
 */
export const INVOICE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 random bytes as lowercase hex - the only shape a raw token can have. */
export const INVOICE_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export interface IssuedInvoiceLink {
  id: string;
  rawToken: string; // the URL secret - returned once, never persisted in plaintext
  invoiceUrl: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Capability tokens for the customer-facing invoice page. Same primitives as
 * PaymentUploadTokenService (256-bit random secret, only its SHA-256 hash stored,
 * so a database leak yields no usable links); different semantics, hence its own
 * table - see OrderInvoiceToken in schema.prisma.
 */
@Injectable()
export class InvoiceTokenService {
  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /** The customer-facing storefront origin, shared with the payment-upload links. */
  private get baseUrl(): string {
    const base = (process.env.PAYMENT_UPLOAD_BASE_URL ?? '').replace(/\/+$/, '');
    if (!base) {
      throw new ServiceUnavailableException('Invoice links are not configured (PAYMENT_UPLOAD_BASE_URL is not set)');
    }
    return base;
  }

  buildUrl(rawToken: string): string {
    return `${this.baseUrl}/invoice/${rawToken}`;
  }

  /**
   * Issue a new link for an order. Other links stay active until `revokeOthers`
   * is called, so a caller can abandon the new link (see `discard`) without
   * having killed the one the customer already has.
   */
  async issue(orderId: string, createdById: string | null): Promise<IssuedInvoiceLink> {
    void this.baseUrl; // unconfigured origin: fail before writing anything
    const rawToken = randomBytes(32).toString('hex'); // 256-bit secret
    const expiresAt = new Date(this.nowMs() + INVOICE_LINK_TTL_MS);
    const row = await this.prisma.orderInvoiceToken.create({
      data: { tokenHash: this.hash(rawToken), orderId, expiresAt, createdById },
      select: { id: true, createdAt: true },
    });
    return { id: row.id, rawToken, invoiceUrl: this.buildUrl(rawToken), expiresAt, createdAt: row.createdAt };
  }

  /** Revoke every still-active link of the order except `keepId`. */
  async revokeOthers(orderId: string, keepId: string): Promise<number> {
    const res = await this.prisma.orderInvoiceToken.updateMany({
      where: { orderId, id: { not: keepId }, revokedAt: null },
      data: { revokedAt: new Date(this.nowMs()) },
    });
    return res.count;
  }

  /** Remove a link that was never handed out (e.g. its WhatsApp send was refused). */
  async discard(id: string): Promise<void> {
    await this.prisma.orderInvoiceToken.deleteMany({ where: { id } });
  }

  /**
   * The order a raw token grants access to, or null when the token is malformed,
   * unknown, revoked or expired. Malformed input never reaches the database.
   */
  async resolveOrderId(rawToken: string): Promise<string | null> {
    if (typeof rawToken !== 'string' || !INVOICE_TOKEN_SHAPE.test(rawToken)) return null;
    const row = await this.prisma.orderInvoiceToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
      select: { orderId: true, expiresAt: true, revokedAt: true },
    });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= this.nowMs()) return null;
    return row.orderId;
  }

  /** The order's current active link (metadata only - the raw token is never recoverable). */
  async activeLink(orderId: string): Promise<{ createdAt: Date; expiresAt: Date } | null> {
    return this.prisma.orderInvoiceToken.findFirst({
      where: { orderId, revokedAt: null, expiresAt: { gt: new Date(this.nowMs()) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, expiresAt: true },
    });
  }
}
