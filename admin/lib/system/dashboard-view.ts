import type { SystemDashboard, SysHealthColor } from '@/lib/admin';

/**
 * Pure, backend-passthrough view-model selectors for the System Dashboard. All
 * values come straight from the aggregated backend payload; these helpers only
 * shape/label them for rendering (so the UI logic is unit-testable without React).
 */

export type KpiTone = 'default' | 'ok' | 'warn' | 'error';
export type KpiCard = { key: string; label: string; value: string; tone: KpiTone };

const rp = (n: number) => n.toLocaleString('id-ID');

export function summaryCards(d: SystemDashboard): KpiCard[] {
  const s = d.summary;
  return [
    { key: 'requests', label: 'Total Request Hari Ini', value: rp(s.totalRequestsToday), tone: 'default' },
    { key: 'avg', label: 'Rata-rata Waktu Respons', value: `${rp(s.avgResponseTimeMs)}ms`, tone: 'default' },
    { key: 'errorRate', label: 'Tingkat Error', value: `${s.errorRatePct}%`, tone: s.errorRatePct >= 5 ? 'error' : s.errorRatePct > 1 ? 'warn' : 'ok' },
    { key: 'warnings', label: 'Peringatan Hari Ini', value: rp(s.warningsToday), tone: s.warningsToday > 0 ? 'warn' : 'default' },
    { key: 'errors', label: 'Error Hari Ini', value: rp(s.errorsToday), tone: s.errorsToday > 0 ? 'error' : 'ok' },
    { key: 'workers', label: 'Worker Aktif', value: rp(s.activeWorkers), tone: 'default' },
    { key: 'pendingNotif', label: 'Notifikasi Tertunda', value: rp(s.pendingNotifications), tone: s.pendingNotifications > 0 ? 'warn' : 'default' },
    { key: 'pendingQueue', label: 'Antrean Tertunda', value: rp(s.pendingQueue), tone: s.pendingQueue > 0 ? 'warn' : 'default' },
  ];
}

/** Success % of a channel (0 when there is no traffic). Display-only, not money. */
export function successRate(ch: { success: number; failed: number }): number {
  const total = ch.success + ch.failed;
  return total === 0 ? 0 : Math.round((ch.success / total) * 100);
}
export function failureRate(ch: { success: number; failed: number }): number {
  const total = ch.success + ch.failed;
  return total === 0 ? 0 : Math.round((ch.failed / total) * 100);
}

export const WORKER_DOT: Record<SysHealthColor, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-red-500',
  gray: 'bg-gray-300',
};
export const WORKER_LABEL: Record<SysHealthColor, string> = {
  green: 'Berjalan',
  yellow: 'Diam / menurun',
  red: 'Gagal',
  gray: 'Nonaktif',
};

/** Bar values (counts) for the errors-per-hour chart. */
export function errorBars(byHour: Array<{ count: number }>): number[] {
  return byHour.map((h) => h.count);
}
