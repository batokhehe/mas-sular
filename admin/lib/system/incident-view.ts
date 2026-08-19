import type { Incident, IncidentSeverity, IncidentStatus } from '@/lib/admin';

/** Pure view helpers for the Incident Center (backend values rendered verbatim). */

// Spec colors: CRITICAL red, HIGH orange, MEDIUM yellow, LOW blue, INFO gray.
export const SEVERITY_BADGE: Record<IncidentSeverity, string> = {
  CRITICAL: 'bg-red-100 text-red-700',
  HIGH: 'bg-orange-100 text-orange-700',
  MEDIUM: 'bg-amber-100 text-amber-700',
  LOW: 'bg-blue-100 text-blue-700',
  INFO: 'bg-gray-100 text-gray-600',
};

export const STATUS_BADGE: Record<IncidentStatus, string> = {
  OPEN: 'bg-red-100 text-red-700',
  ACKNOWLEDGED: 'bg-amber-100 text-amber-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
};

/** Duration an incident has been firing: lastSeen − firstSeen, humanized. */
export function incidentDuration(firstSeen: string, lastSeen: string): string {
  const ms = Math.max(0, new Date(lastSeen).getTime() - new Date(firstSeen).getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Clickable related links for the drawer (label + admin route). */
export function incidentLinks(i: Incident): Array<{ label: string; href: string; id: string }> {
  const links: Array<{ label: string; href: string; id: string }> = [];
  if (i.requestId) links.push({ label: 'Request', href: `/system/requests/${encodeURIComponent(i.requestId)}`, id: i.requestId });
  if (i.orderId) links.push({ label: 'Order', href: `/orders/${i.orderId}`, id: i.orderId });
  if (i.paymentId) links.push({ label: 'Payment', href: '/payments', id: i.paymentId });
  if (i.shipmentId) links.push({ label: 'Shipment', href: `/shipping/${i.shipmentId}`, id: i.shipmentId });
  return links;
}

/** Which lifecycle actions apply to the CURRENT status (button visibility). */
export function incidentActions(status: IncidentStatus): { canAcknowledge: boolean; canResolve: boolean } {
  return {
    canAcknowledge: status === 'OPEN',
    canResolve: status === 'OPEN' || status === 'ACKNOWLEDGED',
  };
}
