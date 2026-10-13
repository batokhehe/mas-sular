import { Prisma } from '@prisma/client';
import { TrackingObservation, withTrackingObservation } from './shipment-metadata';
import { lockShipmentRow } from './shipment-row-lock';

/** The part of PrismaService this needs (keeps callers and test doubles narrow). */
interface TransactionRunner {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Persist a courier observation the shared transition rule refused to apply, in
 * Shipment.metadata.tracking.rejected - so a stale or backwards answer is kept, not
 * lost, without ever moving the shipment. Under the shipment row lock (it merges
 * with metadata the JNE webhook may be writing concurrently). Returns true only when
 * the observation was new; a repeat writes nothing.
 */
export async function recordRejectedObservation(
  prisma: TransactionRunner,
  shipmentId: string,
  observation: Omit<TrackingObservation, 'firstSeenAt'>,
  seenAt: Date = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockShipmentRow(tx, shipmentId);
    const row = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { metadata: true } });
    if (!row) return false;
    const { next, added } = withTrackingObservation(row.metadata, observation, seenAt);
    if (!added) return false;
    await tx.shipment.update({ where: { id: shipmentId }, data: { metadata: next } });
    return true;
  });
}
