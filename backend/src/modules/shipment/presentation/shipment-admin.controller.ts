import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { PrepareShipmentDto } from '../application/dto/prepare-shipment.dto';
import { ReconcileShipmentDto } from '../application/dto/reconcile-shipment.dto';
import { ShipmentService } from '../shipment.service';

@ApiTags('admin-shipment')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/orders', version: '1' })
export class ShipmentAdminController {
  constructor(private readonly shipments: ShipmentService) {}

  /** Retry shipment creation for an order whose shipment is FAILED. */
  @Permissions('Shipment.create')
  @Post(':orderId/shipment/retry')
  retry(@Param('orderId') orderId: string) {
    return this.shipments.retry(orderId);
  }

  /**
   * Manual reconciliation of an UNKNOWN shipment (courier outcome unknown, or the
   * courier accepted a booking this system could not record). The operator checks
   * with the courier first; this never calls the courier. `booked` records the AWB
   * and ships the order in one transaction; `not_booked` makes the shipment FAILED
   * so Retry is offered again.
   */
  @Permissions('Shipment.update')
  @Post(':orderId/shipment/reconcile')
  reconcile(@CurrentAdmin() admin: AdminUser, @Param('orderId') orderId: string, @Body() dto: ReconcileShipmentDto) {
    const actor = admin?.email ?? admin?.sub;
    if (dto.outcome === 'booked') {
      return this.shipments.reconcileBooking(
        orderId,
        { outcome: 'booked', trackingNumber: dto.trackingNumber ?? '', providerShipmentId: dto.providerShipmentId, note: dto.note },
        actor,
      );
    }
    return this.shipments.reconcileBooking(orderId, { outcome: 'not_booked', cancelledAtCourier: dto.cancelledAtCourier, note: dto.note }, actor);
  }

  /**
   * Admin packing action: book one or more orders with a pickup slot the
   * operator selected.
   *
   * Each order is reported individually and a failure never fails its
   * neighbours — a batch of ten where one product is unmeasured must book the
   * other nine and say precisely which one did not, rather than reporting a
   * blanket success or rolling everything back.
   */
  @Permissions('Shipment.create')
  @Post('shipments/prepare')
  async prepare(@Body() dto: PrepareShipmentDto) {
    const results = [];
    for (const orderId of dto.orderIds) {
      try {
        const outcome = await this.shipments.prepareForOrder(orderId, {
          pickupAtIso: dto.pickupAt,
          service: dto.service,
        });
        results.push({
          orderId,
          ok: outcome.ok,
          status: outcome.status,
          trackingNumber: outcome.trackingNumber ?? null,
          error: outcome.error ?? null,
        });
      } catch (error) {
        results.push({
          orderId,
          ok: false,
          status: null,
          trackingNumber: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, booked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
}
