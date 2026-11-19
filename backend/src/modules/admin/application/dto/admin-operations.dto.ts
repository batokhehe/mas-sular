import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';
import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';
import { SHIPPING_LIST_ACTIVE_SCOPE } from '../../shipping-list-scope';

export const ADMIN_ORDER_SEARCH_MAX_LENGTH = 100;

export class ListAdminOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  /**
   * Free-text search over order number, customer name and customer email
   * (case-insensitive, partial). Trimmed; blank means "no search".
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsString()
  @MaxLength(ADMIN_ORDER_SEARCH_MAX_LENGTH)
  search?: string;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

export class VerifyAdminPaymentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectAdminPaymentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateShipmentDto {
  @IsString()
  orderId!: string;

  @IsString()
  provider!: string;

  @IsString()
  service!: string;

  @IsInt()
  @Min(0)
  cost!: number;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  trackingUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateShipmentDto {
  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  trackingUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListAdminShipmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  /**
   * Optional list scope. `active` = the Admin → Shipping list: only shipments that are
   * not delivered/cancelled and whose order is not final (see shipping-list-scope.ts).
   * Omitted = every shipment, exactly as before.
   */
  @IsOptional()
  @IsIn([SHIPPING_LIST_ACTIVE_SCOPE])
  scope?: typeof SHIPPING_LIST_ACTIVE_SCOPE;
}
