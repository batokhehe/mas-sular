import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

/** The four Paxel services this application books. */
export const PAXEL_BOOKABLE_SERVICES = ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR'] as const;

export class PrepareShipmentDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  orderIds!: string[];

  /**
   * The pickup slot the admin committed to, ISO-8601.
   *
   * Required on THIS endpoint, and never defaulted here: it exists so a person
   * can state an appointment explicitly, and the exact value is stored and sent
   * to Paxel unchanged.
   *
   * Since PAXELBOX-61AG.3.32 the normal flow no longer comes through here — a
   * settled payment resolves its own slot from the global cutoff rule and books
   * automatically. This endpoint remains the OVERRIDE and recovery path: an
   * explicitly-chosen slot always wins over the automatic one, and is never
   * recomputed. There is still no operating-hours, weekend or holiday model in
   * the application, and this endpoint does not invent one either.
   */
  @IsDateString()
  pickupAt!: string;

  /** Optional override; otherwise the service quoted at checkout is used. */
  @IsOptional()
  @IsIn(PAXEL_BOOKABLE_SERVICES as unknown as string[])
  service?: string;
}
