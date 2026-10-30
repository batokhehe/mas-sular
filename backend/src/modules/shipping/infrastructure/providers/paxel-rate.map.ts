/**
 * The single place Paxel's rate vocabulary is written down.
 *
 * Every literal here was read off the Paxel eCommerce API Postman collection,
 * not inferred: INSTANT is the odd one out on BOTH axes - it posts to a
 * different endpoint (`/rates/instant`, not `/rates/city`) and its service_type
 * is the two-word `INSTANT GOSEND`. Assuming the obvious `INSTANT` on
 * `/rates/city` would fail against the real API.
 *
 * The domain speaks `PAXEL_SAMEDAY`; only this file knows what Paxel calls it.
 */

/** Domain-facing service codes. The rest of the application uses these. */
export const PAXEL_SERVICES = ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR'] as const;

export type PaxelServiceCode = (typeof PAXEL_SERVICES)[number];

export interface PaxelServiceSpec {
  /** Path appended to the configured base URL. */
  path: string;
  /** Exact `service_type` Paxel expects in the request body. */
  serviceType: string;
  /** Human label surfaced to checkout. */
  label: string;
  /**
   * Documented upper bound for `weight`, in grams, for this endpoint. The city
   * endpoint caps at 5000 and instant at 25000 - a parcel over the cap is a
   * hard failure, never a silently clamped request.
   */
  maxWeightGram: number;
  /**
   * Whether checkout quotes this service. Off = never priced, so never offered,
   * selectable or ordered (order creation selects only from the quotes). The
   * code stays in PAXEL_SERVICES, so an order already on it is still recognised,
   * booked and tracked. Turning a service back on is a reviewed code change.
   */
  offeredAtCheckout: boolean;
}

const CITY_PATH = '/rates/city';
const INSTANT_PATH = '/rates/instant';

/** Paxel documents `weight` as between:1,N per endpoint. */
export const PAXEL_MIN_WEIGHT_GRAM = 1;

const SPECS: Record<PaxelServiceCode, PaxelServiceSpec> = {
  // Hidden from checkout (2026-10-30): INSTANT GOSEND is not offered to customers.
  PAXEL_INSTANT: { path: INSTANT_PATH, serviceType: 'INSTANT GOSEND', label: 'Paxel Instant', maxWeightGram: 25_000, offeredAtCheckout: false },
  PAXEL_SAMEDAY: { path: CITY_PATH, serviceType: 'SAMEDAY', label: 'Paxel Same Day', maxWeightGram: 5_000, offeredAtCheckout: true },
  PAXEL_NEXTDAY: { path: CITY_PATH, serviceType: 'NEXTDAY', label: 'Paxel Next Day', maxWeightGram: 5_000, offeredAtCheckout: true },
  PAXEL_REGULAR: { path: CITY_PATH, serviceType: 'REGULAR', label: 'Paxel Regular', maxWeightGram: 5_000, offeredAtCheckout: true },
};

/** The services checkout quotes, in PAXEL_SERVICES order. */
export const PAXEL_CHECKOUT_SERVICES: readonly PaxelServiceCode[] = PAXEL_SERVICES.filter((service) => SPECS[service].offeredAtCheckout);

export function paxelServiceSpec(service: PaxelServiceCode): PaxelServiceSpec {
  return SPECS[service];
}

export function isPaxelServiceCode(value: string): value is PaxelServiceCode {
  return (PAXEL_SERVICES as readonly string[]).includes(value);
}
