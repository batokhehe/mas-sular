import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { ShippingRateDto } from '../application/dto/shipping.dto';
import { ShippingService } from '../shipping.service';

/** Couriers the tracking route may address. Anything else is refused before any provider call. */
export const TRACKABLE_PROVIDERS = ['jne', 'paxel'] as const;
/** AWB / tracking-number shape accepted by the route (bounded, no separators beyond '-'). */
export const AWB_SHAPE = /^[A-Za-z0-9-]{6,40}$/;
/** Each call spends paid courier-API quota: tighter than the global limit. */
export const SHIPPING_LOOKUP_THROTTLE = { limit: 20, ttl: 60_000 } as const;

/**
 * Legacy courier lookups (M3). Neither the storefront nor the admin UI calls these -
 * storefront quotes go through the customer-authenticated /checkout/shipping-cost and
 * /checkout/shipping-options. They used to be PUBLIC, which let anyone spend the
 * shop's JNE/Paxel API quota and look up arbitrary AWBs. They are now admin-only
 * (Shipment.read), throttled per IP, and strictly validated.
 */
@ApiTags('shipping')
@Controller({ path: 'shipping', version: '1' })
@UseGuards(AdminGuard, PermissionGuard)
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Post('rates')
  @Permissions('Shipment.read')
  @Throttle({ default: SHIPPING_LOOKUP_THROTTLE })
  rates(@Body() dto: ShippingRateDto) {
    return this.shipping.calculateRates(dto);
  }

  @Get(':provider/track/:trackingNumber')
  @Permissions('Shipment.read')
  @Throttle({ default: SHIPPING_LOOKUP_THROTTLE })
  track(@Param('provider') provider: string, @Param('trackingNumber') trackingNumber: string) {
    const normalized = provider.toLowerCase();
    if (!(TRACKABLE_PROVIDERS as readonly string[]).includes(normalized)) {
      throw new BadRequestException('Unsupported shipping provider');
    }
    if (!AWB_SHAPE.test(trackingNumber)) {
      throw new BadRequestException('Invalid tracking number');
    }
    return this.shipping.track(normalized, trackingNumber);
  }
}
