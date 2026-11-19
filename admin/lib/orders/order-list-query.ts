/**
 * Admin order list: query building + search state, kept pure so it is testable
 * with node --test. Search is SERVER-side: the list is paginated, and filtering
 * only the loaded page hid every match beyond it (incident BMS-20261118-CKK0SJS2).
 */

/** Mirrors the backend ListAdminOrdersQueryDto limit. */
export const ORDER_SEARCH_MAX_LENGTH = 100;

/** Debounce for the search box before a request is sent. */
export const ORDER_SEARCH_DEBOUNCE_MS = 300;

/** Every OrderStatus value the backend can return, plus ALL (no filter). */
export const ORDER_STATUS_OPTIONS = [
  'ALL',
  'PENDING',
  'PROCESSING',
  'PACKING',
  'SHIPPED',
  'DELIVERING',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OrderStatusOption = (typeof ORDER_STATUS_OPTIONS)[number];

/** Trimmed, length-capped search term; undefined when blank. */
export function normalizeOrderSearch(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? '').trim().slice(0, ORDER_SEARCH_MAX_LENGTH).trim();
  return trimmed === '' ? undefined : trimmed;
}

export type AdminOrdersQueryParams = {
  page?: number;
  limit?: number;
  status?: string;
  paymentStatus?: string;
  search?: string;
};

/** The query string for GET /admin/orders (without the leading '?'). */
export function buildAdminOrdersQuery(params: AdminOrdersQueryParams = {}): string {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.paymentStatus) q.set('paymentStatus', params.paymentStatus);
  const search = normalizeOrderSearch(params.search);
  if (search) q.set('search', search);
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  return q.toString();
}

export type OrderListState = { search: string; page: number };

/** A new (debounced) search term always restarts from page 1; an unchanged one keeps the page. */
export function applySearchChange(state: OrderListState, rawSearch: string): OrderListState {
  const search = normalizeOrderSearch(rawSearch) ?? '';
  if (search === state.search) return state;
  return { search, page: 1 };
}
