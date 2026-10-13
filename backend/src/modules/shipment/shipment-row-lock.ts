import { Prisma } from '@prisma/client';

/**
 * Take the row lock on one shipment for the rest of the caller's transaction.
 *
 * Every read-modify-write of Shipment.metadata (the JNE webhook record, the pollers'
 * rejected observations, an admin metadata edit) takes it first, so concurrent
 * writers serialize and one can never overwrite what another just wrote.
 */
export async function lockShipmentRow(tx: Prisma.TransactionClient, shipmentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Shipment" WHERE id = ${shipmentId} FOR UPDATE`;
}
