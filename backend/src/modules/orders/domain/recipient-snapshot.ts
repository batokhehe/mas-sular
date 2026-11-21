/**
 * Order.recipientSnapshot — the recipient exactly as checkout validated it.
 *
 * Written ONCE, inside the order-create transaction, from the same Address row
 * (with region names) that checkout validated and priced shipping for. Never
 * updated afterwards: editing the customer's saved Address changes `Order.address`
 * (a live relation) but not this snapshot.
 *
 * Values are copied VERBATIM (no trimming or reformatting) — the address was already
 * normalized when it was saved. Region NAMES are stored as text because region
 * master data can be renamed or re-coded later. Deliberately absent: coordinates,
 * the address label, region/user ids — nothing a packing slip or courier needs.
 */
export const RECIPIENT_SNAPSHOT_VERSION = 1 as const;

export interface OrderRecipientSnapshotV1 {
  version: typeof RECIPIENT_SNAPSHOT_VERSION;
  recipientName: string;
  phone: string;
  /** Structured street/detail line (null on legacy free-text addresses). */
  addressDetail: string | null;
  /** The address's free-text full address, as stored. */
  fullAddress: string;
  village: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  /** Courier note / landmark the customer gave. */
  note: string | null;
}

/** The Address shape checkout already loads (ADDRESS_REGION_NAMES include). */
export interface RecipientSnapshotSource {
  recipientName: string;
  phone: string;
  fullAddress: string;
  addressDetail?: string | null;
  notes?: string | null;
  postalCode?: string | null;
  province?: { name: string } | null;
  city?: { name: string } | null;
  district?: { name: string } | null;
  village?: { name: string } | null;
}

export function buildRecipientSnapshot(address: RecipientSnapshotSource): OrderRecipientSnapshotV1 {
  return {
    version: RECIPIENT_SNAPSHOT_VERSION,
    recipientName: address.recipientName,
    phone: address.phone,
    addressDetail: address.addressDetail ?? null,
    fullAddress: address.fullAddress,
    village: address.village?.name ?? null,
    district: address.district?.name ?? null,
    city: address.city?.name ?? null,
    province: address.province?.name ?? null,
    postalCode: address.postalCode ?? null,
    note: address.notes ?? null,
  };
}
