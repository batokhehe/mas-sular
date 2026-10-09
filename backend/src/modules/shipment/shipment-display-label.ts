import { Prisma, ShipmentStatus } from '@prisma/client';
import { readPaxelWebhook } from './shipment-metadata';

export const PAXEL_STATUS_LABEL_ID: Readonly<Record<string, string>> = {
  RTP: 'Kurir sedang menuju lokasi pickup',
  COL: 'Kurir telah tiba di lokasi pickup',
  PRJL: 'Pickup dibatalkan oleh kurir',
  RAP: 'Percobaan pickup ulang',
  PAPV: 'Kurir telah mengambil paket Anda',
  POL: 'Paket sedang dalam perjalanan',
  ODL: 'Kurir telah tiba di locker tujuan',
  POD: 'Kurir sedang menuju tujuan',
  COD: 'Kurir telah tiba di tujuan',
  PDO: 'Pengiriman telah selesai',
  UNDLM: 'Pengiriman tidak berhasil dikirim',
  HAPH: 'Paket ditahan di Paxel Home',
  RTN: 'Paket dikembalikan',
  POLXL: 'Paket berada di locker asal',
  ODLXL: 'Paket berada di locker tujuan',
  CONFIRMED: 'Pengiriman dibuat',
  FAILED3PL: 'Kurir tidak ditemukan',
  CCS: 'Pengiriman dibatalkan',
  ONHOLD3PL: 'Paket ditahan',
};

const INTERNAL_STATUS_LABEL_ID: Readonly<Record<ShipmentStatus, string>> = {
  PENDING: 'Menunggu',
  RATE_SELECTED: 'Menunggu pengiriman',
  CREATED: 'Pengiriman dibuat',
  WAITING_PICKUP: 'Menunggu dijemput kurir',
  PICKED_UP: 'Dijemput kurir',
  IN_TRANSIT: 'Dalam perjalanan',
  OUT_FOR_DELIVERY: 'Sedang diantar',
  DELIVERED: 'Terkirim',
  FAILED: 'Gagal dikirim',
  CANCELLED: 'Dibatalkan',
  UNKNOWN: 'Tidak diketahui',
};

export interface ShipmentStatusHistoryEntry {
  providerStatus: string;
  changedAt: Date;
}

export function paxelStatusDisplayLabel(provider?: string | null, providerStatus?: string | null): string | undefined {
  if (provider?.toLowerCase() !== 'paxel' || !providerStatus) return undefined;
  const key = providerStatus.trim().toUpperCase();
  return Object.hasOwn(PAXEL_STATUS_LABEL_ID, key) ? PAXEL_STATUS_LABEL_ID[key] : undefined;
}

function latestPaxelWebhookStatus(
  metadata: Prisma.JsonValue | null | undefined,
): { code: string; receivedAt: number } | undefined {
  const record = readPaxelWebhook(metadata);
  const code = record?.latest?.latestStatus;
  const receivedAt = record?.lastReceivedAt ? Date.parse(record.lastReceivedAt) : Number.NaN;
  return typeof code === 'string' && code.trim() && Number.isFinite(receivedAt)
    ? { code, receivedAt }
    : undefined;
}

export function latestPaxelStatusCode(
  metadata: Prisma.JsonValue | null | undefined,
  history: readonly ShipmentStatusHistoryEntry[] = [],
): string | undefined {
  const webhook = latestPaxelWebhookStatus(metadata);
  const latestHistory = history.reduce<ShipmentStatusHistoryEntry | undefined>(
    (latest, entry) => (!latest || entry.changedAt > latest.changedAt ? entry : latest),
    undefined,
  );
  if (!latestHistory) return webhook?.code;
  if (!webhook) return latestHistory.providerStatus;
  return latestHistory.changedAt.getTime() > webhook.receivedAt ? latestHistory.providerStatus : webhook.code;
}

export function shipmentDisplayLabel(
  provider: string,
  status: ShipmentStatus,
  providerStatus?: string | null,
): string {
  return paxelStatusDisplayLabel(provider, providerStatus) ?? INTERNAL_STATUS_LABEL_ID[status];
}
