import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { OrderStatus, PaymentStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShipmentService } from '../shipment/shipment.service';
import { trackingCacheKey } from '../shipment/shipment-sync.service';
import { mergeAdminShipmentMetadata } from '../shipment/shipment-metadata';
import { lockShipmentRow } from '../shipment/shipment-row-lock';
import { InventoryReservationService } from '../inventory/inventory-reservation.service';
import { CreateBannerDto } from '../cms/application/dto/banner.dto';
import {
  CreateShipmentDto,
  ListAdminOrdersQueryDto,
  ListAdminShipmentsQueryDto,
  RejectAdminPaymentDto,
  UpdateOrderStatusDto,
  UpdateShipmentDto,
  VerifyAdminPaymentDto,
} from './application/dto/admin-operations.dto';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { orderStatusSourcesFor } from '../orders/domain/order-status-transitions';
import { isSkuUniqueViolation, skuCandidates, skuFromSlug } from './product-sku';
import { assertCoverMatches, assertProductImageList, galleryRows, ORDERED_PRODUCT_IMAGES, sameGallery } from './product-images';
import { CreateCategoryDto } from './application/dto/create-category.dto';
import { CreateProductDto } from './application/dto/create-product.dto';
import { CreatePromoDto } from './application/dto/create-promo.dto';
import { CreateRoleDto } from './application/dto/create-role.dto';
import { CreateToppingDto } from './application/dto/create-topping.dto';
import { UpdateBannerDto } from './application/dto/update-banner.dto';
import { UpdateCategoryDto } from './application/dto/update-category.dto';
import { UpdateProductDto } from './application/dto/update-product.dto';
import { UpdatePromoDto } from './application/dto/update-promo.dto';
import { UpdateRoleDto } from './application/dto/update-role.dto';
import { UpdateToppingDto } from './application/dto/update-topping.dto';
import { ALL_PERMISSION_NAMES } from '../../../prisma/bootstrap/permission-catalogue';
import {
  assertCustomerRoles,
  assertGrantablePermissions,
  assertMutableRole,
  assertRoleAdministrator,
  RoleActor,
  validateCustomRoleName,
} from './role-policy';
import { UpdateUserDto } from './application/dto/update-user.dto';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { buildOrderTimeline, computeAvailableActions } from './order-operations.util';
import { activeShippingWhere, SHIPPING_LIST_ACTIVE_SCOPE } from './shipping-list-scope';
import { buildOutboxEvent } from '../../infrastructure/outbox/outbox-event.builder';

// Payment terminal states now live with the settlement service (Phase 5D) so that
// admin verification and gateway settlement cannot drift apart. Re-exported here
// only for the reject flow below, which shares the same state machine.
import {
  isTerminalPaymentStatus,
  PaymentSettlementService,
  TERMINAL_PAYMENT_STATUSES,
} from '../payments/settlement/payment-settlement.service';

// Embed region names on address reads so admin Order/Customer/Shipping detail can
// render the full hierarchy. Legacy addresses (null region ids) return null here
// and the UI falls back to `fullAddress`.
const ADDRESS_WITH_REGIONS = {
  include: {
    province: { select: { id: true, code: true, name: true } },
    city: { select: { id: true, code: true, name: true, type: true } },
    district: { select: { id: true, code: true, name: true } },
    village: { select: { id: true, code: true, name: true, postalCode: true } },
  },
} as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: OrderCancellationService,
    // Optional so existing unit tests that construct AdminService with 2 args keep
    // working; when absent, automatic shipment creation is skipped.
    @Optional() private readonly shipments?: ShipmentService,
    // Optional: commits reservations on verify, releases on reject (legacy flow
    // when absent — stock was decremented at checkout).
    @Optional() private readonly inventory?: InventoryReservationService,
    // Phase 5D: the shared settlement path. Optional so the many existing tests that
    // construct AdminService positionally keep working — see `settlement` below.
    @Optional() private readonly injectedSettlement?: PaymentSettlementService,
    // PAXELBOX-33: used only to drop a stale tracking response after a manual
    // shipment edit. Optional for the same reason as the deps above, and safe
    // to be absent — invalidation is best-effort, not a guard.
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) { }

  private lazySettlement?: PaymentSettlementService;

  /**
   * The shared settlement path. When Nest did not inject one (positional test
   * construction), build it from the collaborators we already hold — the resulting
   * behaviour is identical, because that is exactly what the DI container passes.
   */
  private get settlement(): PaymentSettlementService {
    return (this.injectedSettlement ??
      (this.lazySettlement ??= new PaymentSettlementService(
        this.prisma, this.shipments, this.inventory, this.cancellation,
      )));
  }

  async getDashboard() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const now = new Date();

    const [ordersToday, revenueToday, pendingPayments, activeProducts, lowStockProducts, totalOrders, totalUsers, pendingOrders, verifiedOrders, ordersByStatus, allPromos, totalRedemptions, voucherUsageByVoucher] = await Promise.all([
      this.prisma.order.count({ where: { deletedAt: null, createdAt: { gte: startOfToday } } }),
      this.prisma.order.aggregate({
        where: { deletedAt: null, payment: { status: PaymentStatus.PAID } },
        _sum: { totalPrice: true },
      }),
      this.prisma.payment.count({ where: { deletedAt: null, status: PaymentStatus.WAITING_VERIFICATION } }),
      this.prisma.product.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      this.prisma.product.count({ where: { deletedAt: null, stock: { lte: 10 } } }),
      this.prisma.order.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.order.count({ where: { deletedAt: null, status: OrderStatus.PENDING } }),
      this.prisma.order.count({ where: { deletedAt: null, status: { in: [OrderStatus.PROCESSING, OrderStatus.DELIVERING, OrderStatus.COMPLETED] } } }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { status: true },
      }),
      this.prisma.promo.findMany({ where: { deletedAt: null } }),
      this.prisma.voucherUsage.count(),
      this.prisma.voucherUsage.groupBy({
        by: ['voucherId'],
        _count: { voucherId: true },
        orderBy: { _count: { voucherId: 'desc' } },
        take: 5,
      }),
    ]);

    const validVouchers = allPromos.filter((promo) => {
      if (!promo.isActive) return false;
      if (promo.startDate && promo.startDate > now) return false;
      if (promo.endDate && promo.endDate < now) return false;
      if (promo.maxUsageCount !== null && promo.currentUsageCount >= promo.maxUsageCount) return false;
      return true;
    });

    const topUsedVouchers = await Promise.all(
      voucherUsageByVoucher.map(async (group) => {
        const promo = await this.prisma.promo.findUnique({ where: { id: group.voucherId } });
        return {
          voucherId: group.voucherId,
          code: promo?.code ?? 'unknown',
          title: promo?.title ?? 'Unknown voucher',
          redemptions: group._count.voucherId,
        };
      }),
    );

    return {
      ordersToday,
      totalOrders,
      totalUsers,
      pendingOrders,
      verifiedOrders,
      totalRevenue: revenueToday._sum.totalPrice ?? 0,
      pendingPayments,
      activeProducts,
      lowStockProducts,
      activeVouchers: validVouchers.length,
      expiredVouchers: allPromos.length - validVouchers.length,
      totalVouchers: allPromos.length,
      totalRedemptions,
      topUsedVouchers,
      ordersByStatus: Object.fromEntries(ordersByStatus.map((item) => [item.status, item._count.status])),
    };
  }

  async createProduct(dto: CreateProductDto) {
    // P2 gallery. `images` is never spread into Product data: it becomes a nested
    // create, atomic with the product row. With images[] the cover is images[0];
    // without it the legacy imageUrl is the cover (its validation is unchanged) and
    // becomes the single gallery image, so Product.imageUrl = images[0] from day one.
    const { images, ...fields } = dto;
    const gallery = images !== undefined ? assertProductImageList(images) : undefined;
    if (gallery) assertCoverMatches(fields.imageUrl, gallery);
    const imageUrl = gallery ? gallery[0] : fields.imageUrl;
    if (imageUrl === undefined) throw new BadRequestException('imageUrl or images is required');
    const data = { ...fields, imageUrl, images: { create: galleryRows(gallery ?? [imageUrl]) } };

    // An explicit SKU is honoured exactly as before (P2 #5).
    if (data.sku?.trim()) return this.prisma.product.create({ data });

    // Otherwise assign one from the unique slug. SKU stays load-bearing (it is the
    // Paxel item code), so a product must never be created without one; and a
    // blank '' is never written because it would collide on @unique. Only a SKU
    // collision moves to the next candidate - any other error (a duplicate slug,
    // say) surfaces exactly as it did before.
    const { sku: _blank, ...rest } = data;
    for (const sku of skuCandidates(skuFromSlug(dto.slug))) {
      try {
        return await this.prisma.product.create({ data: { ...rest, sku } });
      } catch (err) {
        if (!isSkuUniqueViolation(err)) throw err;
      }
    }
    throw new ConflictException('Could not assign a unique SKU for this product; set one explicitly.');
  }

  listProducts() {
    return this.prisma.product.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  /** Admin detail (edit form): the product plus its ordered gallery. The list never loads images. */
  async getProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id }, include: { images: ORDERED_PRODUCT_IMAGES } });
    if (!product || product.deletedAt) throw new NotFoundException('Product not found');
    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    const current = await this.getProduct(id);
    // The Admin form no longer sends a SKU (P2 #5), so an edit leaves the stored SKU
    // untouched. A blank SKU is treated as "not provided" rather than written: ''
    // would erase the Paxel item code and collide on @unique. A non-blank SKU from
    // an API client is still applied as before.
    const { sku, images, ...rest } = dto;
    const data = sku?.trim() ? { ...rest, sku } : rest;

    // No gallery change and no new cover: exactly the previous single update.
    const coverChanged = rest.imageUrl !== undefined && rest.imageUrl !== current.imageUrl;
    if (images === undefined && !coverChanged) {
      return this.prisma.product.update({ where: { id }, data });
    }

    // Validate before opening the transaction. A url the product already has
    // (legacy /products/*.jpg included) stays valid; a new one must be an upload.
    const existing = new Set([current.imageUrl, ...(current.images ?? []).map((image) => image.url)]);
    const gallery = images !== undefined ? assertProductImageList(images, existing) : undefined;
    if (gallery) assertCoverMatches(rest.imageUrl, gallery);

    // One transaction: the product row, the gallery and the cover never diverge.
    return this.prisma.$transaction(async (tx) => {
      if (gallery) {
        if (!sameGallery(current.images ?? [], gallery)) {
          await tx.productImage.deleteMany({ where: { productId: id } });
          await tx.productImage.createMany({ data: galleryRows(gallery).map((row) => ({ ...row, productId: id })) });
        }
        return tx.product.update({ where: { id }, data: { ...data, imageUrl: gallery[0] }, include: { images: ORDERED_PRODUCT_IMAGES } });
      }
      // imageUrl-only change (API clients): the cover row follows; other images stay.
      const imageUrl = rest.imageUrl as string;
      await tx.productImage.upsert({
        where: { productId_sortOrder: { productId: id, sortOrder: 0 } },
        update: { url: imageUrl },
        create: { productId: id, url: imageUrl, sortOrder: 0 },
      });
      return tx.product.update({ where: { id }, data, include: { images: ORDERED_PRODUCT_IMAGES } });
    });
  }

  async deleteProduct(id: string) {
    await this.getProduct(id);
    return this.prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: { ...dto } });
  }

  listCategories() {
    return this.prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  }

  async getCategory(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category || category.deletedAt) throw new NotFoundException('Category not found');
    return category;
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    await this.getCategory(id);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async deleteCategory(id: string) {
    await this.getCategory(id);
    return this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /**
   * `startDate`/`endDate` arrive as real Dates: IsBusinessDateTime normalised
   * them at the DTO boundary, reading a naked wall clock as Asia/Jakarta rather
   * than as the server's own timezone. Nothing is parsed here — the previous
   * `new Date(dto.startDate)` did read the process timezone, which is UTC in the
   * container and Asia/Jakarta on a developer machine.
   *
   * Absent still means null on CREATE (a promo with no window), which is not the
   * same as absent on UPDATE — see updatePromo.
   */
  async createPromo(dto: CreatePromoDto) {
    const data = {
      ...dto,
      startDate: dto.startDate ?? null,
      endDate: dto.endDate ?? null,
    };

    return this.prisma.promo.create({ data });
  }

  listPromos() {
    return this.prisma.promo.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  async getPromo(id: string) {
    const promo = await this.prisma.promo.findUnique({ where: { id } });
    if (!promo || promo.deletedAt) throw new NotFoundException('Promo not found');
    return promo;
  }

  /**
   * A PATCH is sparse: only the keys actually sent are written, so an omitted
   * `startDate` leaves the stored window alone. That is why the dto is spread
   * straight through rather than being defaulted to null the way create does —
   * defaulting here would wipe the promo window on every unrelated edit.
   *
   * This is the method that produced "Invalid value for argument `startDate`:
   * premature end of input": it passed the dto to Prisma untouched, so before
   * IsBusinessDateTime the raw browser string "2026-09-12T09:59" went straight
   * to the driver. The dates are now already Dates by the time they get here.
   */
  async updatePromo(id: string, dto: UpdatePromoDto) {
    await this.getPromo(id);
    return this.prisma.promo.update({ where: { id }, data: dto });
  }

  async deletePromo(id: string) {
    await this.getPromo(id);
    return this.prisma.promo.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /**
   * Toppings. The storefront lists active, non-deleted ones and checkout re-prices
   * each chosen topping from this table (orders.service getCartPricing), while every
   * placed order keeps its own OrderItemTopping name/price snapshot - so editing a
   * price here only affects orders placed afterwards. Delete is a soft delete, like
   * the rest of the catalogue: ordered toppings stay referenced by OrderItemTopping.
   */
  createTopping(dto: CreateToppingDto) {
    return this.prisma.topping.create({ data: { ...dto } });
  }

  /** Active and inactive alike - the admin needs to see what customers do not. */
  listToppings() {
    return this.prisma.topping.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  }

  async getTopping(id: string) {
    const topping = await this.prisma.topping.findUnique({ where: { id } });
    if (!topping || topping.deletedAt) throw new NotFoundException('Topping not found');
    return topping;
  }

  async updateTopping(id: string, dto: UpdateToppingDto) {
    await this.getTopping(id);
    return this.prisma.topping.update({ where: { id }, data: dto });
  }

  async deleteTopping(id: string) {
    await this.getTopping(id);
    return this.prisma.topping.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async createBanner(dto: CreateBannerDto) {
    return this.prisma.banner.create({ data: { ...dto } });
  }

  listBanners() {
    return this.prisma.banner.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
  }

  async getBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner || banner.deletedAt) throw new NotFoundException('Banner not found');
    return banner;
  }

  async updateBanner(id: string, dto: UpdateBannerDto) {
    await this.getBanner(id);
    return this.prisma.banner.update({ where: { id }, data: dto });
  }

  async deleteBanner(id: string) {
    await this.getBanner(id);
    return this.prisma.banner.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listOrders(query: ListAdminOrdersQueryDto) {
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      status: query.status,
      payment: query.paymentStatus ? { status: query.paymentStatus } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          address: ADDRESS_WITH_REGIONS,
          items: { include: { toppings: true } },
          payment: true,
          shipment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        address: ADDRESS_WITH_REGIONS,
        // product image/sku for the operations-center line items (select → no N+1).
        items: { include: { toppings: true, product: { select: { id: true, sku: true, imageUrl: true } } } },
        payment: {
          include: {
            transactions: { orderBy: { createdAt: 'asc' } },
            // Phase 4: latest gateway attempt for the admin read-only panel
            // (provider, provider status, gateway transaction id).
            gatewayTransactions: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
        shipment: { include: { history: { orderBy: { changedAt: 'asc' } } } },
        // Inventory reservations (allocated outlet + reserved qty) for the ops view.
        reservations: {
          include: { outlet: { select: { id: true, name: true } }, product: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
        events: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Read-only "operations center" bundle: customer lifetime history, unified
   * timeline (order + payment + inventory + shipment), valid quick actions, audit
   * logs, notification history, and the active payment account. One focused
   * findUnique + a parallel Promise.all (no N+1). Never mutates state.
   */
  async getOrderOperations(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        deletedAt: true,
        createdAt: true,
        payment: {
          select: {
            id: true,
            status: true,
            verifiedAt: true,
            manualReceiptUrl: true,
            createdAt: true,
            transactions: { select: { status: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
        },
        shipment: {
          select: {
            createdAt: true,
            status: true,
            trackingNumber: true,
            trackingUrl: true,
            history: { select: { mappedStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          },
        },
        events: { select: { status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        reservations: { select: { status: true, createdAt: true, product: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    const paymentId = order.payment?.id;

    const [customerAgg, customerCount, auditLogs, notifications, paymentAccount] = await Promise.all([
      this.prisma.order.aggregate({ where: { userId: order.userId, deletedAt: null, payment: { status: PaymentStatus.PAID } }, _sum: { totalPrice: true } }),
      this.prisma.order.count({ where: { userId: order.userId, deletedAt: null } }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ entity: 'Order', entityId: id }, ...(paymentId ? [{ entity: 'Payment', entityId: paymentId }] : [])] },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, actorId: true, action: true, entity: true, entityId: true, ipAddress: true, after: true, createdAt: true },
      }),
      this.prisma.notificationOutbox.findMany({
        // PostgreSQL JSON path filter: an array of keys. MySQL took a JSONPath
        // string ("$.orderId"); Prisma types the two differently per provider.
        where: { payload: { path: ['orderId'], equals: id } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, channel: true, template: true, status: true, attempts: true, providerMessageId: true, sentAt: true, createdAt: true },
      }),
      this.prisma.paymentAccount.findFirst({ where: { isActive: true }, select: { bankName: true, bankCode: true, accountName: true, accountNumber: true } }),
    ]);

    return {
      customerHistory: { totalOrders: customerCount, lifetimeRevenue: customerAgg._sum.totalPrice ?? 0 },
      timeline: buildOrderTimeline({
        createdAt: order.createdAt,
        events: order.events,
        payment: order.payment
          ? { createdAt: order.payment.createdAt, status: order.payment.status, verifiedAt: order.payment.verifiedAt, transactions: order.payment.transactions }
          : null,
        shipment: order.shipment ? { createdAt: order.shipment.createdAt, history: order.shipment.history } : null,
        reservations: order.reservations,
      }),
      availableActions: computeAvailableActions({
        status: order.status,
        payment: order.payment ? { status: order.payment.status, manualReceiptUrl: order.payment.manualReceiptUrl } : null,
        shipment: order.shipment ? { status: order.shipment.status, trackingNumber: order.shipment.trackingNumber, trackingUrl: order.shipment.trackingUrl } : null,
      }),
      auditLogs,
      notifications,
      paymentAccount,
    };
  }

  async updateOrderStatus(id: string, dto: UpdateOrderStatusDto) {
    const current = await this.getOrder(id);

    // Idempotent no-op: already in the requested status → no event, no outbox.
    if (current.status === dto.status) {
      return this.prisma.order.findUnique({ where: { id }, include: { payment: true, shipment: true } });
    }

    if (dto.status === OrderStatus.CANCELLED) {
      // Cancellation restocks inventory exactly once via the shared transition;
      // order.status_updated is emitted only when this call actually cancels.
      return this.prisma.$transaction(async (tx) => {
        const { cancelled } = await this.cancellation.cancelAndRestock(tx, id, dto.note ?? `Order marked as ${OrderStatus.CANCELLED}`);
        if (cancelled) {
          await tx.outboxEvent.create({
            data: buildOutboxEvent({
              aggregateType: 'order',
              aggregateId: id,
              eventName: 'order.status_updated',
              exchange: 'orders',
              routingKey: 'order.status_updated',
              payload: { orderId: id, status: OrderStatus.CANCELLED },
              metadata: { source: 'admin.updateOrderStatus' },
            }),
          });
        }
        return tx.order.findUnique({ where: { id }, include: { payment: true, shipment: true } });
      }, { timeout: 10000 });
    }

    // Non-CANCELLED transitions: legal-transition CAS (audit F4) — the status only
    // flips when the CURRENT status may legally move to the target (never out of
    // CANCELLED/COMPLETED, never backwards). Status + OrderEvent + outbox commit
    // atomically; a lost CAS (concurrent transition) is a 409, not a silent write.
    return this.prisma.$transaction(async (tx) => {
      const flip = await tx.order.updateMany({
        where: { id, status: { in: orderStatusSourcesFor(dto.status) } },
        data: { status: dto.status },
      });
      if (flip.count !== 1) {
        throw new ConflictException(`Order cannot transition from ${current.status} to ${dto.status}`);
      }
      await tx.orderEvent.create({
        data: { orderId: id, status: dto.status, note: dto.note ?? `Order marked as ${dto.status}` },
      });
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { payment: true, shipment: true },
      });
      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'order',
          aggregateId: order.id,
          eventName: 'order.status_updated',
          exchange: 'orders',
          routingKey: 'order.status_updated',
          payload: { orderId: order.id, status: order.status },
          metadata: { source: 'admin.updateOrderStatus' },
        }),
      });
      return order;
    }, { timeout: 10000 });
  }

  listPayments(status: PaymentStatus = PaymentStatus.WAITING_VERIFICATION, search?: string) {
    const term = search?.trim();
    // A fully-numeric term matches the transfer amount (which already includes the
    // unique code), so finance can paste the incoming amount (e.g. "135123") to find
    // the order. Text terms match order number / customer name / email.
    const amount = term && /^\d+$/.test(term) ? Number(term) : undefined;
    return this.prisma.payment.findMany({
      where: {
        deletedAt: null,
        status,
        ...(term
          ? {
              OR: [
                { order: { orderNumber: { contains: term } } },
                { order: { user: { name: { contains: term } } } },
                { order: { user: { email: { contains: term } } } },
                ...(amount !== undefined ? [{ amount }] : []),
              ],
            }
          : {}),
      },
      include: {
        order: {
          include: {
            user: { select: { id: true, name: true, email: true, phone: true } },
            items: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin verification. The transition itself lives in PaymentSettlementService
   * (Phase 5D) so that admin verify and Midtrans settlement share ONE state machine,
   * one inventory commit path, one shipment path and one payment.paid construction.
   * The external contract here — 404, idempotent replay, 409 on a terminal status,
   * and the returned Payment — is unchanged.
   */
  async verifyPayment(paymentId: string, adminId: string, dto: VerifyAdminPaymentDto) {
    const outcome = await this.settlement.settle(paymentId, {
      kind: 'ADMIN',
      adminId,
      note: dto.note ?? null,
    });
    return outcome.payment;
  }

  /**
   * Admin rejection. Like verifyPayment, the transition itself lives in
   * PaymentSettlementService (Phase 5E) so admin, webhook and reconciliation share
   * ONE FAILED path. External contract unchanged: 404, idempotent replay, 409 on a
   * terminal status, and the returned Payment.
   */
  async rejectPayment(paymentId: string, dto: RejectAdminPaymentDto) {
    const outcome = await this.settlement.fail(
      paymentId,
      { kind: 'SYSTEM', source: 'admin.rejectPayment', note: dto.note ?? null },
      dto.note ?? 'Payment rejected by admin',
    );
    return outcome.payment;
  }

  async createShipment(dto: CreateShipmentDto) {
    await this.getOrder(dto.orderId);
    return this.prisma.shipment.create({
      data: {
        orderId: dto.orderId,
        provider: dto.provider,
        service: dto.service,
        cost: dto.cost,
        status: dto.status ?? ShipmentStatus.PENDING,
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
      },
      include: { order: true },
    });
  }

  async listShipments(query: ListAdminShipmentsQueryDto) {
    const { skip, take, page, limit } = pageArgs(query);
    // Without a scope the filter is exactly what it always was; `active` narrows it
    // to the Admin → Shipping list (both halves apply to findMany AND count, so the
    // pagination totals match what is shown).
    const where: Prisma.ShipmentWhereInput =
      query.scope === SHIPPING_LIST_ACTIVE_SCOPE ? { AND: [{ status: query.status }, activeShippingWhere()] } : { status: query.status };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: {
          order: {
            include: {
              user: { select: { id: true, name: true, email: true, phone: true } },
              address: ADDRESS_WITH_REGIONS,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getShipment(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            user: { select: { id: true, name: true, email: true, phone: true } },
            address: ADDRESS_WITH_REGIONS,
          },
        },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return shipment;
  }

  /**
   * Drop the cached courier answer for this parcel, if there is one to drop.
   *
   * Best-effort by design, and deliberately NOT a safety boundary: the repo's
   * cache convention is that a cache fault degrades to uncached work rather
   * than failing it, and failing to invalidate only restores the pre-existing
   * behaviour (the next tick may reason about an answer up to the TTL old).
   */
  private async invalidateTrackingCache(provider: string, trackingNumber: string | null): Promise<void> {
    if (!this.cache || !trackingNumber) return;
    try {
      await this.cache.del(trackingCacheKey(provider, trackingNumber));
    } catch {
      // Cache unreachable — the edit itself must still succeed.
    }
  }

  async updateShipment(id: string, dto: UpdateShipmentDto) {
    const existing = await this.getShipment(id);

    // A shipment that already carries an airwaybill describes a booking a
    // courier has accepted. Re-pointing it at a different provider or service
    // would leave the record describing something nobody agreed to ship, while
    // the real parcel keeps moving under the original terms — and the customer
    // was priced for that original service. Changing it needs a rebooking, not
    // an edit, so the edit is refused rather than silently applied.
    //
    // Compared by VALUE, not presence: the edit form resubmits every field, so
    // rejecting a merely-present provider/service would make a booked shipment
    // completely uneditable — even for its cost or tracking URL.
    const booked = Boolean(existing.trackingNumber || existing.providerShipmentId);
    if (booked) {
      const retargeted: string[] = [];
      if (dto.provider !== undefined && dto.provider !== existing.provider) retargeted.push('provider');
      if (dto.service !== undefined && dto.service !== existing.service) retargeted.push('service');
      if (retargeted.length > 0) {
        throw new ConflictException(
          `Cannot change the ${retargeted.join(' or ')} of a shipment that already has an airwaybill ` +
            `(${existing.trackingNumber ?? existing.providerShipmentId}). Cancel and rebook instead.`,
        );
      }

      // PAXELBOX-33: the airwaybill itself is not editable once one exists.
      //
      // Every other writer of trackingNumber copies it from the courier's own
      // CREATE response (shipment.service post-CREATE, reached by verify, admin
      // retry and reconciliation alike). This PATCH is the only place an
      // arbitrary value can be written, and replacing a booked AWB silently
      // detaches the record from the real parcel: tracking would poll a number
      // the courier never issued for this shipment, the original booking would
      // keep moving untracked, and the stored providerShipmentId/payload would
      // describe a different consignment than the field beside them.
      //
      // Presence is fine — the edit form resubmits every field — so this
      // compares by VALUE, exactly like the provider/service guard above.
      if (dto.trackingNumber !== undefined && dto.trackingNumber !== existing.trackingNumber) {
        throw new ConflictException(
          `Cannot replace the airwaybill of a shipment that is already booked ` +
            `(${existing.trackingNumber ?? existing.providerShipmentId}). Cancel and rebook instead.`,
        );
      }
    }

    // A manual edit can move the shipment to a status that is still polled. The
    // courier's last answer stays reusable for the PAXELBOX-27 TTL (2h), so the
    // very next tick could compare against a response older than the edit and
    // overwrite it. Dropping the key costs one cache round-trip and makes the
    // next tick ask the courier again; it does not change what tracking
    // concludes, only how fresh the answer it reasons about is.
    //
    // Only meaningful once a courier identity exists — a draft has nothing
    // cached under it.
    await this.invalidateTrackingCache(existing.provider, existing.trackingNumber);

    const fields = {
      provider: dto.provider,
      service: dto.service,
      cost: dto.cost,
      status: dto.status,
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
    };
    if (dto.metadata === undefined) {
      return this.prisma.shipment.update({ where: { id }, data: fields, include: { order: true } });
    }

    // A metadata edit MERGES into what is stored (never a wholesale replace), under
    // the shipment row lock so it cannot overwrite what the JNE webhook or a poller
    // is writing at the same moment. System-owned paths (jne.webhook, tracking) keep
    // their stored value whatever the edit contains.
    return this.prisma.$transaction(async (tx) => {
      await lockShipmentRow(tx, id);
      const current = await tx.shipment.findUnique({ where: { id }, select: { metadata: true } });
      return tx.shipment.update({
        where: { id },
        data: { ...fields, metadata: mergeAdminShipmentMetadata(current?.metadata, dto.metadata as Record<string, unknown>) },
        include: { order: true },
      });
    });
  }

  async deleteShipment(id: string) {
    const existing = await this.getShipment(id);

    // Once a courier has issued an airwaybill there is a real parcel booked in
    // the outside world. Deleting the row does not cancel it: the booking stays
    // live, while the only records of it here — providerShipmentId, the stored
    // provider payload, the pickup slot and the whole status history (which
    // cascades) — are destroyed, and the order is left SHIPPED with no shipment
    // row, so it can never be re-booked or tracked again.
    //
    // The providers DO implement cancelShipment(), but nothing in the
    // application calls it yet, so there is no in-app way to undo the booking
    // first. Until that is wired up, refusing is the only option that cannot
    // silently strand a parcel. Unbooked drafts stay deletable.
    const airwaybill = existing.trackingNumber ?? existing.providerShipmentId;
    if (airwaybill) {
      throw new ConflictException(
        `Cannot delete shipment ${airwaybill}: the courier booking would stay live while its record is destroyed. ` +
          `Cancel the booking with the courier first.`,
      );
    }

    return this.prisma.shipment.delete({ where: { id } });
  }

  listUsers() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: true } },
        addresses: ADDRESS_WITH_REGIONS,
        orders: true,
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');
    return user;
  }

  /** H1: SUPER_ADMIN only; custom roles only; reserved names and non-catalogue permissions refused. */
  async createRole(dto: CreateRoleDto, actor: RoleActor) {
    assertRoleAdministrator(actor);
    const name = validateCustomRoleName(dto.name);
    await this.assertRoleNameAvailable(name);
    const permissionIds = dto.permissionIds ?? [];
    await this.assertGrantable(permissionIds);
    return this.prisma.role.create({
      data: {
        name,
        description: dto.description,
        permissions: permissionIds.length ? { create: [...new Set(permissionIds)].map((permissionId) => ({ permissionId })) } : undefined,
      },
      include: { permissions: { include: { permission: true } } },
    });
  }

  /** Case-insensitive uniqueness, so "Ops Lead" and "ops lead" cannot coexist. */
  private async assertRoleNameAvailable(name: string, exceptId?: string) {
    const clash = await this.prisma.role.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException('A role with this name already exists');
  }

  private async assertGrantable(permissionIds: readonly string[]) {
    if (permissionIds.length === 0) return;
    const found = await this.prisma.permission.findMany({
      where: { id: { in: [...new Set(permissionIds)] } },
      select: { id: true, subject: true, action: true },
    });
    assertGrantablePermissions(permissionIds, found);
  }

  listRoles() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async getRole(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  /**
   * Updates a role under optimistic concurrency (C7b).
   *
   * The permission set is replaced wholesale, so the previous unconditional write was
   * last-writer-wins: two administrators who opened the same role both saved
   * successfully and the second silently discarded the first's change. Reproduced
   * against a real database - A added a permission, B saved its stale set, A's grant
   * was gone with no error anywhere. The dangerous direction is that a stale set can
   * also resurrect a permission somebody just revoked.
   *
   * The guard is a compare-and-swap on `updatedAt`, which the schema already carries -
   * no version column, no migration. It runs FIRST, inside the transaction: if the row
   * no longer holds the timestamp the caller read, nothing has been deleted yet and the
   * throw rolls the transaction back, so a conflict can never leave a half-replaced
   * permission set.
   *
   * `updatedAt` is bumped explicitly rather than left to @updatedAt, because Prisma only
   * touches it when a scalar actually changes - a permissions-only edit would otherwise
   * leave the timestamp untouched and the next caller's stale token would still match.
   */
  async updateRole(id: string, dto: UpdateRoleDto, actor: RoleActor) {
    // H1, in this order: who may edit roles at all, then which roles are editable.
    assertRoleAdministrator(actor);
    const current = await this.getRole(id);
    assertMutableRole(current);
    const heldByActor = await this.prisma.adminRole.findFirst({ where: { adminId: actor.sub, roleId: id }, select: { roleId: true } });
    if (heldByActor) throw new ForbiddenException('You cannot modify a role you hold');
    const name = dto.name !== undefined ? validateCustomRoleName(dto.name) : undefined;
    if (name !== undefined) await this.assertRoleNameAvailable(name, id);
    if (dto.permissionIds) await this.assertGrantable(dto.permissionIds);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.role.updateMany({
        where: { id, updatedAt: new Date(dto.expectedUpdatedAt) },
        data: {
          ...(name ? { name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          updatedAt: new Date(),
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          'Role was modified by another administrator. Please reload and retry.',
        );
      }

      if (dto.permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (dto.permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: [...new Set(dto.permissionIds)].map((permissionId) => ({ roleId: id, permissionId })),
          });
        }
      }

      return tx.role.findUniqueOrThrow({
        where: { id },
        include: { permissions: { include: { permission: true } } },
      });
    });
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    await this.getUser(id);
    // L3: a customer-management endpoint must never turn a customer into an admin.
    if (dto.roleIds) {
      const roles = await this.prisma.role.findMany({ where: { id: { in: [...new Set(dto.roleIds)] } }, select: { id: true, name: true } });
      assertCustomerRoles(dto.roleIds, roles);
    }

    const updateData: Prisma.UserUpdateInput = {
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    if (dto.roleIds) {
      const [, user] = await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: id } }),
        this.prisma.user.update({
          where: { id },
          data: {
            ...updateData,
            roles: {
              create: [...new Set(dto.roleIds)].map((roleId) => ({ roleId })),
            },
          },
          include: { roles: { include: { role: true } }, addresses: ADDRESS_WITH_REGIONS, orders: true },
        }),
      ]);
      return user;
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { roles: { include: { role: true } }, addresses: ADDRESS_WITH_REGIONS, orders: true },
    });
  }

  /** Only canonical catalogue permissions are offered; retired legacy rows are hidden and not grantable. */
  async listPermissions() {
    const catalogue = new Set(ALL_PERMISSION_NAMES);
    const rows = await this.prisma.permission.findMany({ orderBy: [{ subject: 'asc' }, { action: 'asc' }] });
    return rows.filter((p) => catalogue.has(`${p.subject}.${p.action}`));
  }
}
