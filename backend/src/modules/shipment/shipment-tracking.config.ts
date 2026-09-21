import { positiveInt } from '../../common/utils/number.util';
export const SHIPMENT_TRACKING_CONFIG = 'SHIPMENT_TRACKING_CONFIG';

/** Provider key of JNE shipments (JneShipmentProvider.name). */
export const JNE_TRACKING_PROVIDER = 'jne';

export interface ShipmentTrackingConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  /**
   * How long a courier's RAW tracking response stays reusable.
   *
   * This is a RESPONSE cache, not a polling cooldown: the worker keeps its own
   * interval, and every tick still runs the full map → CAS → history → order →
   * notify pipeline. Within the TTL it just reuses the last answer the courier
   * gave for that airwaybill instead of asking again.
   */
  cacheTtlMs: number;
  /**
   * JNE_TRACKING_POLL_ENABLED - only the exact string "true" lets the poller ask JNE.
   * Off by default: JNE shipment status comes from the JNE webhook (webhook-only mode),
   * so the poller skips JNE shipments entirely. Other couriers keep being polled under
   * SHIPMENT_TRACKING_ENABLED as before. The JNE tracking provider itself is unchanged.
   */
  jnePollingEnabled: boolean;
}

export function loadShipmentTrackingConfig(env: NodeJS.ProcessEnv = process.env): ShipmentTrackingConfig {
  return {
    enabled: env.SHIPMENT_TRACKING_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.SHIPMENT_TRACKING_POLL_INTERVAL_MS, 300_000),
    batchSize: positiveInt(env.SHIPMENT_TRACKING_BATCH_SIZE, 50),
    // 2 hours. One place, so the worker interval and this cannot drift apart.
    cacheTtlMs: positiveInt(env.SHIPMENT_TRACKING_CACHE_TTL_MS, 7_200_000),
    jnePollingEnabled: env.JNE_TRACKING_POLL_ENABLED === 'true',
  };
}
