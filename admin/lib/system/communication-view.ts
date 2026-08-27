import type { ConversationItem, ManualSendTemplate } from '@/lib/admin';

/** Pure view helpers for the Customer Communication Center (no I/O — unit-testable). */

// ---------------- Manual send templates (UI descriptors; templates live in backend code) ----------------

export const MANUAL_SEND_TEMPLATES: Array<{
  value: ManualSendTemplate;
  label: string;
  needsOrderNumber: boolean;
  needsSubject: boolean;
}> = [
  { value: 'manual.order-update', label: 'Order Update', needsOrderNumber: true, needsSubject: false },
  { value: 'manual.shipment-update', label: 'Shipment Update', needsOrderNumber: true, needsSubject: false },
  { value: 'manual.custom', label: 'Custom Message', needsOrderNumber: false, needsSubject: true },
];

// ---------------- Communication history badges ----------------

export type HistoryBadge = { label: string; cls: string };

/**
 * Badges for one history row: outcome (Success/Failed/Queued), origin
 * (Manual/Auto), plus Retry (needed >1 attempt) and Resend (admin re-queued it).
 */
export function historyBadges(n: {
  status: string;
  attempts: number;
  isManual: boolean;
  resendAt: string | null;
}): HistoryBadge[] {
  const badges: HistoryBadge[] = [];
  if (n.status === 'SENT') badges.push({ label: 'Success', cls: 'bg-emerald-100 text-emerald-700' });
  else if (n.status === 'FAILED') badges.push({ label: 'Failed', cls: 'bg-red-100 text-red-700' });
  else badges.push({ label: 'Queued', cls: 'bg-amber-100 text-amber-700' });
  if (n.attempts > 1) badges.push({ label: `Retry ×${n.attempts - 1}`, cls: 'bg-purple-100 text-purple-700' });
  if (n.resendAt) badges.push({ label: 'Resend', cls: 'bg-blue-100 text-blue-700' });
  badges.push(
    n.isManual
      ? { label: 'Manual', cls: 'bg-indigo-100 text-indigo-700' }
      : { label: 'Auto', cls: 'bg-gray-100 text-gray-600' },
  );
  return badges;
}

// ---------------- Delivery tracking (read-only, derived) ----------------

export type DeliveryTone = 'ok' | 'error' | 'pending';
export type DeliveryStep = { label: string; at: string | null; tone: DeliveryTone; detail?: string };

/**
 * Delivery tracking for one notification: Queued → Sending → Provider Accepted →
 * Delivered, or the Failed/Retry chain. The pipeline stores counters, not a
 * per-attempt log, so intermediate failures have no timestamp; "Provider
 * Accepted" and "Delivered" both anchor on sentAt (the pipeline records the
 * provider's accept — there are no downstream delivery receipts).
 */
export function deliveryTimeline(n: {
  status: string;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerMessageId: string | null;
}): DeliveryStep[] {
  const steps: DeliveryStep[] = [{ label: 'Queued', at: n.createdAt, tone: 'ok' }];

  if (n.attempts <= 0) {
    steps.push({ label: 'Sending', at: n.nextAttemptAt, tone: 'pending', detail: 'Waiting for the sender worker' });
    return steps;
  }

  for (let attempt = 1; attempt <= n.attempts; attempt += 1) {
    steps.push({ label: attempt === 1 ? 'Sending' : `Retry #${attempt - 1}`, at: null, tone: 'ok' });
    if (attempt < n.attempts) steps.push({ label: 'Failed', at: null, tone: 'error' });
  }

  if (n.status === 'SENT') {
    steps.push({
      label: 'Provider Accepted',
      at: n.sentAt,
      tone: 'ok',
      detail: n.providerMessageId ? `Provider message ${n.providerMessageId}` : undefined,
    });
    steps.push({ label: 'Delivered', at: n.sentAt, tone: 'ok' });
  } else if (n.status === 'FAILED') {
    steps.push({ label: 'Failed', at: null, tone: 'error', detail: n.lastError ?? undefined });
  } else {
    steps.push({ label: 'Failed', at: null, tone: 'error', detail: n.lastError ?? undefined });
    steps.push({ label: `Retry #${n.attempts}`, at: n.nextAttemptAt, tone: 'pending', detail: 'Scheduled' });
  }
  return steps;
}

// ---------------- Conversation grouping ----------------

export type ConversationGroup = {
  key: string;
  kind: 'order' | 'payment' | 'shipment' | 'general';
  label: string;
  items: ConversationItem[];
};

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/**
 * Group a chronological conversation by its related resource (order first, then
 * payment, then shipment; everything else lands in General). Groups are ordered
 * by their first notification; items inside stay chronological.
 */
export function conversationGroups(items: ConversationItem[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
  for (const item of items) {
    const r = item.related;
    let key: string;
    let kind: ConversationGroup['kind'];
    let label: string;
    if (r.orderId) {
      key = `order:${r.orderId}`;
      kind = 'order';
      label = `Order ${r.orderNumber ?? short(r.orderId)}`;
    } else if (r.paymentId) {
      key = `payment:${r.paymentId}`;
      kind = 'payment';
      label = `Payment ${short(r.paymentId)}`;
    } else if (r.shipmentId) {
      key = `shipment:${r.shipmentId}`;
      kind = 'shipment';
      label = `Shipment ${short(r.shipmentId)}`;
    } else {
      key = 'general';
      kind = 'general';
      label = 'General';
    }
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { key, kind, label, items: [item] });
  }
  return [...groups.values()];
}

// ---------------- Timeline event labels ----------------

/** Human label for one conversation event (falls back to the raw template key). */
export function templateLabel(n: { template: string; stage: string | null; statusLabel: string | null; isManual: boolean }): string {
  switch (n.template) {
    case 'order.transfer':
      return 'Order Created — Waiting Payment';
    case 'order.cod':
      return 'Order Created (COD)';
    case 'order.received':
      return 'Order Received';
    case 'payment.reminder':
      return n.stage === 'second' ? 'Payment Reminder (48h)' : 'Payment Reminder (24h)';
    case 'payment.receipt_uploaded':
      return 'Payment Uploaded';
    case 'payment.approved':
      return 'Payment Verified';
    case 'payment.rejected':
      return 'Payment Rejected';
    case 'payment.expired':
      return 'Payment Expired';
    case 'order.shipped':
      return 'Shipped';
    case 'order.delivered':
      return 'Delivered';
    case 'shipment.status':
      return n.statusLabel ? `Shipment: ${n.statusLabel}` : 'Shipment Update';
    case 'manual.order-update':
      return 'Manual: Order Update';
    case 'manual.shipment-update':
      return 'Manual: Shipment Update';
    case 'manual.custom':
      return 'Manual Message';
    default:
      return n.template;
  }
}

// ---------------- Formatting ----------------

/** Rupiah label for lifetime value (whole rupiah; id-ID separators). */
export function idr(amount: number): string {
  return `Rp ${Math.round(amount).toLocaleString('id-ID')}`;
}
