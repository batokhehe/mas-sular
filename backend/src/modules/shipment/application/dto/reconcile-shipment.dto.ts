import { Equals, IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

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

  /**
   * Required for `not_booked`: the operator affirms the courier confirmed there is NO
   * active booking for this order. A timeout is never evidence of that.
   */
  @ValidateIf((dto: ReconcileShipmentDto) => dto.outcome === 'not_booked')
  @Equals(true)
  confirmNoActiveBooking?: boolean;

  /** Required for `not_booked`: courier ticket / case id / portal reference for that confirmation. */
  @ValidateIf((dto: ReconcileShipmentDto) => dto.outcome === 'not_booked')
  @IsString()
  @Length(3, 200)
  courierCheckReference?: string;

  /** not_booked only: confirms a booking the courier issued was cancelled with the courier. */
  @IsOptional()
  @IsBoolean()
  cancelledAtCourier?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
