import type { PerfEndpoint, PerfRange } from '@/lib/admin';

/** Pure view helpers for the Performance page (backend values rendered verbatim). */

export const PERF_RANGES: Array<{ key: PerfRange; label: string }> = [
  { key: '1h', label: 'Last Hour' },
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

/** 950 → "950ms"; 2400 → "2.4s". Display-only. */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.round(ms)}ms`;
}

export type EndpointSortKey = 'avgMs' | 'maxMs' | 'p95' | 'p99' | 'count' | 'endpoint';
export type SortDir = 'asc' | 'desc';

/** Sortable endpoint table (stable copy; never mutates the source rows). */
export function sortEndpoints(rows: PerfEndpoint[], key: EndpointSortKey, dir: SortDir): PerfEndpoint[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'endpoint') return a.endpoint.localeCompare(b.endpoint) * sign;
    return (a[key] - b[key]) * sign;
  });
}

/** Case-insensitive endpoint search (method + path). */
export function filterEndpoints(rows: PerfEndpoint[], term: string): PerfEndpoint[] {
  const t = term.trim().toLowerCase();
  if (!t) return rows;
  return rows.filter((r) => r.endpoint.toLowerCase().includes(t));
}

/** Latency tone: green < 300ms, amber < 1000ms, red otherwise. */
export function latencyTone(avgMs: number): 'ok' | 'warn' | 'error' {
  if (avgMs < 300) return 'ok';
  if (avgMs < 1000) return 'warn';
  return 'error';
}
