import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

/**
 * Manual reconciliation of an UNKNOWN shipment (ShipmentService.reconcileBooking),
 * after the operator has checked with the courier. Never calls the courier.
 */
export class ReconcileShipmentDto {
  /** booked: the courier holds the booking. not_booked: it holds none. */
  @IsIn(['booked', 'not_booked'])
  outcome!: 'booked' | 'not_booked';

  /** Required for `booked`: the airwaybill the courier issued. */
  @ValidateIf((dto: ReconcileShipmentDto) => dto.outcome === 'booked')
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/)
  trackingNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerShipmentId?: string;

  /** not_booked only: confirms a booking the courier issued was cancelled with the courier. */
  @IsOptional()
  @IsBoolean()
  cancelledAtCourier?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
