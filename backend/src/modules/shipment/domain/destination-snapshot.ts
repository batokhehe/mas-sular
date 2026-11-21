/**
 * Shipment.destinationSnapshot — the receiver as it was ACTUALLY submitted to the
 * courier in a successful booking.
 *
 * Built by each provider from the request object it really sent (after its own
 * transformations), returned with the booking result, and persisted by
 * ShipmentService in the same transaction as the AWB. Never built for a failed or
 * ambiguous booking, never rebuilt afterwards.
 *
 *  - JNE /pickupcashless: RECEIVER_ADDR1 / RECEIVER_ADDR2 are single-line and cut to
 *    30 characters (toJneAddressLine). `addressTruncated` records whether that cut
 *    removed text, so nothing ever presents these lines as the complete address.
 *    Village/district are not separate JNE fields (they are inside RECEIVER_ADDR2).
 *  - Paxel POST /shipments: `destination` is sent as-is, so the snapshot is complete.
 *    Coordinates WERE sent but are not kept (`coordinatesSubmitted` says so): a
 *    precise location is not needed to print or audit the label.
 *
 * `providerFields` holds the receiver-side fields verbatim under the provider's own
 * names. Never credentials, never shipper/pickup fields, never items or values.
 */
export const DESTINATION_SNAPSHOT_VERSION = 1 as const;

export interface ShipmentDestinationSnapshotV1 {
  version: typeof DESTINATION_SNAPSHOT_VERSION;
  /** Provider id as registered ('jne' | 'paxel'). */
  provider: string;
  /** When the booking response was accepted (ISO-8601). */
  capturedAt: string;
  recipientName: string;
  phone: string | null;
  /** Address lines exactly as submitted, in order (empty lines omitted). */
  addressLines: string[];
  village: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  note: string | null;
  /** True when the provider request shortened the address text. */
  addressTruncated: boolean;
  /** Paxel only: latitude/longitude were part of the request (not stored). */
  coordinatesSubmitted?: boolean;
  /** Receiver-side request fields, verbatim, keyed by the provider's own names. */
  providerFields: Record<string, string>;
}
