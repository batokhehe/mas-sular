import type { AuditDiffEntry, AuditEntry, AuditFilters } from '@/lib/admin';

/** Pure view helpers for the Audit Trail (backend values rendered verbatim). */

export const AUDIT_ACTION_BADGE: Record<string, string> = {
  CREATE: 'bg-emerald-100 text-emerald-700',
  UPDATE: 'bg-blue-100 text-blue-700',
  DELETE: 'bg-red-100 text-red-700',
  RESTORE: 'bg-emerald-100 text-emerald-700',
  LOGIN: 'bg-purple-100 text-purple-700',
  LOGOUT: 'bg-gray-100 text-gray-600',
  VERIFY_PAYMENT: 'bg-emerald-100 text-emerald-700',
  REJECT_PAYMENT: 'bg-red-100 text-red-700',
  SHIP_ORDER: 'bg-indigo-100 text-indigo-700',
  CANCEL_ORDER: 'bg-red-100 text-red-700',
  TRANSFER_STOCK: 'bg-amber-100 text-amber-700',
  APPROVE: 'bg-emerald-100 text-emerald-700',
  REVOKE: 'bg-red-100 text-red-700',
  ASSIGN_ROLE: 'bg-purple-100 text-purple-700',
  REMOVE_ROLE: 'bg-amber-100 text-amber-700',
  UPLOAD_RECEIPT: 'bg-blue-100 text-blue-700',
  UPLOAD_IMAGE: 'bg-blue-100 text-blue-700',
  SEND_MANUAL_NOTIFICATION: 'bg-pink-100 text-pink-700',
};

export function actionBadge(action: string): string {
  return AUDIT_ACTION_BADGE[action] ?? 'bg-gray-100 text-gray-600';
}

/** Entity → admin route (clickable links in the drawer). Null when no page exists. */
export function entityHref(entity: string, entityId: string | null): string | null {
  if (!entityId) return null;
  switch (entity) {
    case 'Order': return `/orders/${entityId}`;
    case 'Payment': return '/payments';
    case 'Shipment': return `/shipping/${entityId}`;
    case 'Product': return `/products/${entityId}`;
    case 'Promo':
    case 'Voucher': return `/promos/${entityId}`;
    case 'ProductInventory':
    case 'Inventory': return '/inventory/products';
    case 'StockTransfer': return '/inventory/transfers';
    case 'User':
    case 'Customer': return `/users/${entityId}`;
    case 'Role': return `/roles/${entityId}`;
    case 'Outlet': return `/outlets/${entityId}`;
    case 'PaymentAccount': return `/payment-accounts/${entityId}`;
    case 'Category': return '/categories';
    default: return null;
  }
}

/** One-line summary for the table: diff count or the action itself. */
export function entrySummary(entry: Pick<AuditEntry, 'diff' | 'action' | 'entityName'>): string {
  const changed = entry.diff?.length ?? 0;
  if (changed > 0) return `${changed} field${changed > 1 ? 's' : ''} changed`;
  if (entry.entityName) return entry.entityName;
  return entry.action.toLowerCase().replace(/_/g, ' ');
}

/** Diff rows for the viewer — verbatim backend values, display-stringified. */
export function diffRows(diff: AuditDiffEntry[] | null): Array<{ field: string; before: string; after: string }> {
  return (diff ?? []).map((d) => ({
    field: d.field,
    before: display(d.before),
    after: display(d.after),
  }));
}

function display(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------- Filter persistence (remember filters) ----------------

export const AUDIT_FILTER_KEY = 'mas-sular-admin-audit-filters';

export function serializeFilters(filters: AuditFilters): string {
  return JSON.stringify(filters);
}

export function parseFilters(raw: string | null): AuditFilters {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as AuditFilters;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Download filename for the CSV export. */
export function csvFilename(now = new Date()): string {
  return `audit-trail-${now.toISOString().slice(0, 10)}.csv`;
}
