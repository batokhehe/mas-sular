import type { NotificationCenterFilters, NotificationChannel, NotificationSendStatus } from '@/lib/admin';

/** Pure view helpers for the Notification Center (backend values rendered verbatim). */

// Channel filter list — PUSH/SMS are future-ready (already in the backend enum).
export const CHANNELS: NotificationChannel[] = ['WHATSAPP', 'EMAIL', 'PUSH', 'SMS'];
export const SEND_STATUSES: NotificationSendStatus[] = ['PENDING', 'SENT', 'FAILED'];

export const NOTIF_STATUS_BADGE: Record<NotificationSendStatus, string> = {
  SENT: 'bg-emerald-100 text-emerald-700',
  PENDING: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
};

export const CHANNEL_BADGE: Record<string, string> = {
  WHATSAPP: 'bg-emerald-100 text-emerald-700',
  EMAIL: 'bg-blue-100 text-blue-700',
  PUSH: 'bg-purple-100 text-purple-700',
  SMS: 'bg-amber-100 text-amber-700',
  IN_APP: 'bg-gray-100 text-gray-600',
};

/** Delivery duration label: null → —, 12 → 12s, 90 → 1m 30s. */
export function deliveryLabel(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** Whether the resend action applies (FAILED only — mirrors the backend guard). */
export function canResend(status: NotificationSendStatus): boolean {
  return status === 'FAILED';
}

/** Success-trend chart series: per-day success percentage (0 when no traffic). */
export function trendSeries(trend: Array<{ day: string; sent: number; failed: number }>): Array<{ label: string; value: number }> {
  return trend.map((t) => {
    const total = t.sent + t.failed;
    return { label: t.day, value: total === 0 ? 0 : Math.round((t.sent / total) * 100) };
  });
}

// ---------------- Provider ----------------

/** Provider filter options (each maps onto the channel it serves in the backend). */
export const PROVIDERS = [
  { value: 'QONTAK', label: 'Qontak (WhatsApp)' },
  { value: 'RESEND', label: 'Resend (Email)' },
] as const;

/** Human provider name per channel (PUSH/SMS have no provider wired yet). */
export function providerOf(channel: NotificationChannel): string {
  if (channel === 'WHATSAPP') return 'Qontak';
  if (channel === 'EMAIL') return 'Resend';
  return '—';
}

// ---------------- Timeline (read-only, derived) ----------------

export type TimelineTone = 'ok' | 'error' | 'pending';
export type TimelineStep = { label: string; at: string | null; tone: TimelineTone; detail?: string };

/**
 * Derive the delivery timeline from the durable outbox fields. The pipeline keeps
 * counters, not a per-attempt log, so intermediate failures carry no timestamp —
 * only the terminal step does. attempts = send attempts already started;
 * attempt N (N ≥ 2) is displayed as "Retry #(N−1)".
 */
export function buildTimeline(n: {
  status: NotificationSendStatus;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}): TimelineStep[] {
  const steps: TimelineStep[] = [{ label: 'Queued', at: n.createdAt, tone: 'ok' }];

  if (n.attempts <= 0) {
    // Not picked up by the sender worker yet.
    steps.push({ label: 'Sending', at: n.nextAttemptAt, tone: 'pending', detail: 'Waiting for the sender worker' });
    return steps;
  }

  for (let attempt = 1; attempt <= n.attempts; attempt += 1) {
    steps.push({ label: attempt === 1 ? 'Sending' : `Retry #${attempt - 1}`, at: null, tone: 'ok' });
    const isLast = attempt === n.attempts;
    if (!isLast) steps.push({ label: 'Failed', at: null, tone: 'error' });
  }

  if (n.status === 'SENT') {
    steps.push({ label: 'Sent', at: n.sentAt, tone: 'ok' });
  } else if (n.status === 'FAILED') {
    steps.push({ label: 'Failed', at: null, tone: 'error', detail: n.lastError ?? undefined });
  } else {
    // PENDING after ≥1 attempt: last attempt failed, another retry is scheduled.
    steps.push({ label: 'Failed', at: null, tone: 'error', detail: n.lastError ?? undefined });
    steps.push({ label: `Retry #${n.attempts}`, at: n.nextAttemptAt, tone: 'pending', detail: 'Scheduled' });
  }
  return steps;
}

// ---------------- Freshness ("Updated Xs ago") ----------------

/** Label for the last successful refresh: just now / 42s ago / 3m ago. */
export function updatedAgoLabel(updatedAtMs: number, nowMs: number): string {
  if (!updatedAtMs) return '—';
  const s = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ---------------- Filter persistence ----------------

export const FILTER_STORAGE_KEY = 'admin.notification-center.filters.v1';

/**
 * Restore persisted filters defensively: only known keys, only expected types,
 * enum values validated. Anything unrecognized is dropped (stale/corrupt storage
 * must never break the page).
 */
export function sanitizeFilters(raw: unknown): NotificationCenterFilters {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: NotificationCenterFilters = {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

  const channel = str(src.channel);
  if (channel && (CHANNELS as string[]).includes(channel)) out.channel = channel as NotificationChannel;
  const status = str(src.status);
  if (status && (SEND_STATUSES as string[]).includes(status)) out.status = status as NotificationSendStatus;
  const provider = str(src.provider);
  if (provider && PROVIDERS.some((p) => p.value === provider)) out.provider = provider;
  if (src.hasError === 'true' || src.hasError === 'false') out.hasError = src.hasError;
  for (const key of ['template', 'recipient', 'order', 'payment', 'search', 'dateFrom', 'dateTo'] as const) {
    const v = str(src[key]);
    if (v) out[key] = v;
  }
  for (const key of ['retryMin', 'durationMin', 'durationMax'] as const) {
    const v = int(src[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ---------------- Bulk actions ----------------

export const BULK_RETRY_LIMIT = 100;

/** Ids eligible for bulk retry — FAILED only, mirroring the backend guard. */
export function retryableIds(rows: Array<{ id: string; status: NotificationSendStatus }>, selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.id) && canResend(r.status)).map((r) => r.id);
}

// ---------------- Drawer sizing ----------------

export const DRAWER_WIDTH_STORAGE_KEY = 'admin.notification-center.drawer-width.v1';
export const DRAWER_MIN_WIDTH = 420;
export const DRAWER_MAX_WIDTH = 960;
export const DRAWER_DEFAULT_WIDTH = 560;

/** Clamp a persisted/drag width into the allowed drawer range. */
export function clampDrawerWidth(px: number): number {
  if (!Number.isFinite(px)) return DRAWER_DEFAULT_WIDTH;
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, Math.round(px)));
}
