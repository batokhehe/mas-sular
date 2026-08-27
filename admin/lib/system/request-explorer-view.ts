import type { LogLevel, RequestGroup, RequestTimelineEvent } from '@/lib/admin';

/**
 * Pure view helpers for the Request Explorer. Everything renders backend values
 * verbatim; these only group/label/serialize for the UI (unit-testable sans React).
 */

export const GROUP_BADGE: Record<RequestGroup, string> = {
  AUTH: 'bg-purple-100 text-purple-700',
  ORDER: 'bg-indigo-100 text-indigo-700',
  PAYMENT: 'bg-blue-100 text-blue-700',
  INVENTORY: 'bg-amber-100 text-amber-700',
  SHIPMENT: 'bg-cyan-100 text-cyan-700',
  NOTIFICATION: 'bg-pink-100 text-pink-700',
  WORKER: 'bg-slate-100 text-slate-700',
  SYSTEM: 'bg-gray-100 text-gray-600',
};

// Level colors per spec: INFO green, WARN amber, ERROR red, DEBUG gray.
export const LEVEL_DOT: Record<LogLevel, string> = {
  INFO: 'bg-emerald-500',
  WARN: 'bg-amber-400',
  ERROR: 'bg-red-500',
  DEBUG: 'bg-gray-400',
};

export const LEVEL_BADGE: Record<LogLevel, string> = {
  INFO: 'bg-emerald-100 text-emerald-700',
  WARN: 'bg-amber-100 text-amber-700',
  ERROR: 'bg-red-100 text-red-700',
  DEBUG: 'bg-gray-100 text-gray-600',
};

export type TimelineSegment = { group: RequestGroup; events: RequestTimelineEvent[] };

/**
 * Group CONSECUTIVE events of the same group into collapsible segments while
 * preserving strict chronological order (a group reappearing later starts a new
 * segment — never re-sorted into one bucket).
 */
export function segmentTimeline(events: RequestTimelineEvent[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const event of events) {
    const last = segments[segments.length - 1];
    if (last && last.group === event.group) last.events.push(event);
    else segments.push({ group: event.group, events: [event] });
  }
  return segments;
}

/** Stack trace embedded by the exception filter (metadata.stack), if any. */
export function eventStack(event: RequestTimelineEvent): string | null {
  const stack = (event.metadata as { stack?: unknown } | null)?.stack;
  return typeof stack === 'string' && stack.length > 0 ? stack : null;
}

/** Copy/download payload for one event — the full event as pretty JSON. */
export function eventJson(event: RequestTimelineEvent): string {
  return JSON.stringify(event, null, 2);
}

/** Expand/collapse state for every segment index at once. */
export function expandState(count: number, open: boolean): Record<number, boolean> {
  const state: Record<number, boolean> = {};
  for (let i = 0; i < count; i += 1) state[i] = open;
  return state;
}

/** HTTP status tone for badges. */
export function statusTone(statusCode: number | null): 'ok' | 'warn' | 'error' | 'muted' {
  if (statusCode == null) return 'muted';
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'ok';
}
