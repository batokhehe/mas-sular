# Frontend Technical Specification — Mas Sular

Stack: **Next.js 15 (App Router) · TypeScript · Tailwind · shadcn/ui · TanStack Query · React Hook Form · Zod**

Backend contract (audited): base URL `${NEXT_PUBLIC_API_URL}/api/v1`. Bearer JWT for customer (`jwt`) + admin (`admin-jwt`). Responses are **raw Prisma objects** (model columns + included relations). Lists are **plain arrays (no pagination yet)**. `POST /checkout/order` requires an `Idempotency-Key` header. Receipt `receiptUrl` must be an app-owned `/uploads/<image>` URL obtained from the `*/file` upload endpoints.

---

## 1. Folder structure
```
frontend/
├── app/
│   ├── (storefront)/
│   │   ├── layout.tsx                # storefront shell (header/cart)
│   │   ├── login/page.tsx
│   │   ├── catalog/page.tsx
│   │   ├── product/[slug]/page.tsx
│   │   ├── cart/page.tsx
│   │   ├── checkout/page.tsx
│   │   ├── payment/[token]/page.tsx  # public tokenized upload landing
│   │   └── orders/page.tsx
│   ├── (admin)/admin/
│   │   ├── layout.tsx                # admin shell (sidebar, permission gates)
│   │   ├── login/page.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── payments/page.tsx
│   │   ├── orders/page.tsx
│   │   ├── orders/[id]/page.tsx
│   │   └── shipments/page.tsx
│   ├── providers.tsx                 # QueryClientProvider + Toaster + AuthProvider
│   └── layout.tsx
├── lib/
│   ├── api/
│   │   ├── client.ts                 # fetch wrapper: auth, refresh, ApiError, Idempotency-Key
│   │   ├── auth.api.ts
│   │   ├── catalog.api.ts
│   │   ├── checkout.api.ts
│   │   ├── payment.api.ts
│   │   ├── order.api.ts
│   │   └── admin.api.ts
│   ├── types/{enums.ts,models.ts}
│   ├── query/{keys.ts,hooks/*}
│   ├── auth/{tokens.ts,useAuth.tsx,usePermissions.ts}
│   ├── validation/{checkout.schema.ts,address.schema.ts,admin.schema.ts}
│   └── utils/{format.ts,status.ts}
├── components/
│   ├── ui/                           # shadcn primitives
│   ├── common/{Empty.tsx,ErrorState.tsx,Skeletons.tsx,Pagination.tsx}
│   ├── order/{StatusBadge.tsx,OrderCard.tsx}
│   └── payment/{UploadReceipt.tsx,PaymentTimeline.tsx}
├── middleware.ts                     # route guards by token cookie
└── .env.local                        # NEXT_PUBLIC_API_URL=...
```

---

## 2. API client layer

### `lib/api/client.ts`
```ts
import { getTokens, setTokens, clearTokens } from "@/lib/auth/tokens";

const BASE = `${process.env.NEXT_PUBLIC_API_URL}/api/v1`;

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

type Audience = "customer" | "admin" | "public";
interface Options {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  audience?: Audience;          // which token to attach
  headers?: Record<string, string>;
  form?: FormData;              // multipart (file upload)
}

async function raw<T>(path: string, opts: Options, retried = false): Promise<T> {
  const { method = "GET", body, audience = "public", headers = {}, form } = opts;
  const tokens = getTokens();
  const auth =
    audience === "customer" && tokens.access ? { Authorization: `Bearer ${tokens.access}` }
    : audience === "admin" && tokens.adminAccess ? { Authorization: `Bearer ${tokens.adminAccess}` }
    : {};

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...auth, ...headers },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401 && audience === "customer" && !retried && tokens.refresh) {
    const refreshed = await tryRefresh(tokens.refresh);          // single retry on expiry
    if (refreshed) return raw<T>(path, opts, true);
    clearTokens();
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json?.message ?? res.statusText, json);
  return json as T;
}

async function tryRefresh(refresh: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!r.ok) return false;
    const data = await r.json();
    setTokens({ access: data.accessToken, refresh: data.refreshToken });
    return true;
  } catch { return false; }
}

export const api = {
  get:   <T>(p: string, a?: Audience) => raw<T>(p, { audience: a }),
  post:  <T>(p: string, body?: unknown, a?: Audience, headers?: Record<string,string>) => raw<T>(p, { method: "POST", body, audience: a, headers }),
  patch: <T>(p: string, body?: unknown, a?: Audience) => raw<T>(p, { method: "PATCH", body, audience: a }),
  del:   <T>(p: string, a?: Audience) => raw<T>(p, { method: "DELETE", audience: a }),
  upload:<T>(p: string, form: FormData, a?: Audience) => raw<T>(p, { method: "POST", form, audience: a }),
};
```

### `lib/api/auth.api.ts`
```ts
import { api } from "./client";
import type { AuthTokens, AdminSession, User } from "@/lib/types/models";

export const authApi = {
  googleLogin: (idToken: string) => api.post<AuthTokens & { user: User }>("/auth/google", { idToken }),
  refresh: (refreshToken: string) => api.post<AuthTokens>("/auth/refresh", { refreshToken }),
  me: () => api.get<User>("/users/me", "customer"),
  adminLogin: (email: string, password: string) => api.post<{ accessToken: string; admin: AdminSession }>("/admin/auth/login", { email, password }),
  adminMe: () => api.get<AdminSession>("/admin/auth/me", "admin"),
  adminLogout: () => api.post<{ success: boolean }>("/admin/auth/logout", undefined, "admin"),
};
```

### `lib/api/catalog.api.ts`
```ts
import { api } from "./client";
import type { Product, Category, Topping, Promo } from "@/lib/types/models";

export interface ProductQuery { search?: string; category?: string; sort?: "popular" | "price-low" | "price-high" | "rating" }
const qs = (q: Record<string, string | undefined>) =>
  Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");

export const catalogApi = {
  products: (q: ProductQuery = {}) => api.get<Product[]>(`/catalog/products${qs(q) ? `?${qs(q)}` : ""}`),
  product: (idOrSlug: string) => api.get<Product>(`/catalog/products/${idOrSlug}`),
  categories: () => api.get<Category[]>("/catalog/categories"),
  toppings: () => api.get<Topping[]>("/catalog/toppings"),
  promos: () => api.get<Promo[]>("/catalog/promos"),
};
```

### `lib/api/checkout.api.ts`
```ts
import { api } from "./client";
import type { CheckoutItem, ShippingQuote, VoucherPreview, CheckoutSummary, Order } from "@/lib/types/models";

export interface CreateOrderInput {
  address_id: string;
  courier: "paxel" | "jne";
  payment_method?: "COD" | "BANK_TRANSFER" | "QRIS" | "GATEWAY";
  voucher_code?: string;
  items: CheckoutItem[];
}

export const checkoutApi = {
  shippingCost: (b: { address_id: string; courier: string; items: CheckoutItem[] }) => api.post<ShippingQuote>("/checkout/shipping-cost", b, "customer"),
  validateVoucher: (b: { voucher_code: string; subtotal: number }) => api.post<VoucherPreview>("/checkout/validate-voucher", b, "customer"),
  summary: (b: Omit<CreateOrderInput, "payment_method">) => api.post<CheckoutSummary>("/checkout/summary", b, "customer"),
  createOrder: (b: CreateOrderInput, idempotencyKey: string) =>
    api.post<Order>("/checkout/order", b, "customer", { "Idempotency-Key": idempotencyKey }),
};
```

### `lib/api/payment.api.ts`
```ts
import { api } from "./client";
import type { Payment, UploadPage } from "@/lib/types/models";

export interface ReceiptBody { receiptUrl: string; bankName?: string; accountName?: string }

export const paymentApi = {
  // Tokenized (anonymous) link flow
  uploadPage: (token: string) => api.get<UploadPage>(`/payments/upload/${token}`),
  uploadTokenFile: (token: string, file: File) => { const f = new FormData(); f.append("file", file); return api.upload<{ url: string }>(`/payments/upload/${token}/file`, f); },
  submitByToken: (token: string, body: ReceiptBody) => api.post<Payment>(`/payments/upload/${token}`, body),
  // Authenticated (logged-in) flow
  uploadFile: (paymentId: string, file: File) => { const f = new FormData(); f.append("file", file); return api.upload<{ url: string }>(`/payments/${paymentId}/manual-receipt/file`, f, "customer"); },
  submitManual: (paymentId: string, body: ReceiptBody) => api.post<Payment>(`/payments/${paymentId}/manual-receipt`, body, "customer"),
};
```

### `lib/api/order.api.ts`
```ts
import { api } from "./client";
import type { Order } from "@/lib/types/models";

export const orderApi = {
  listForUser: (userId: string, status?: string) => api.get<Order[]>(`/orders/users/${userId}${status ? `?status=${status}` : ""}`, "customer"),
};
```

### `lib/api/admin.api.ts`
```ts
import { api } from "./client";
import type { Order, Payment, Shipment, OrderStatus, PaymentStatus, ShipmentStatus } from "@/lib/types/models";

export const adminApi = {
  dashboard: () => api.get<unknown>("/admin/dashboard", "admin"),
  orders: (q: { status?: OrderStatus; paymentStatus?: PaymentStatus } = {}) =>
    api.get<Order[]>(`/admin/orders${query(q)}`, "admin"),
  order: (id: string) => api.get<Order>(`/admin/orders/${id}`, "admin"),
  updateOrderStatus: (id: string, body: { status: OrderStatus; note?: string }) => api.patch<Order>(`/admin/orders/${id}/status`, body, "admin"),
  payments: (status?: PaymentStatus) => api.get<Payment[]>(`/admin/payments${status ? `?status=${status}` : ""}`, "admin"),
  pendingPayments: () => api.get<Payment[]>("/admin/payments/pending-verification", "admin"),
  verifyPayment: (id: string, note?: string) => api.patch<Payment>(`/admin/payments/${id}/verify`, { note }, "admin"),
  rejectPayment: (id: string, note?: string) => api.patch<Payment>(`/admin/payments/${id}/reject`, { note }, "admin"),
  shipments: (status?: ShipmentStatus) => api.get<Shipment[]>(`/admin/shipments${status ? `?status=${status}` : ""}`, "admin"),
  createShipment: (b: Record<string, unknown>) => api.post<Shipment>("/admin/shipments", b, "admin"),
  updateShipment: (id: string, b: Record<string, unknown>) => api.patch<Shipment>(`/admin/shipments/${id}`, b, "admin"),
};
const query = (q: Record<string, string | undefined>) => { const s = Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("&"); return s ? `?${s}` : ""; };
```

---

## 3. TypeScript models (`lib/types`)

### `enums.ts` (mirror Prisma enums exactly)
```ts
export const OrderStatus = { PENDING: "PENDING", PROCESSING: "PROCESSING", DELIVERING: "DELIVERING", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED" } as const;
export type OrderStatus = keyof typeof OrderStatus;

export const PaymentStatus = { PENDING: "PENDING", WAITING_VERIFICATION: "WAITING_VERIFICATION", PAID: "PAID", FAILED: "FAILED", EXPIRED: "EXPIRED", REFUNDED: "REFUNDED" } as const;
export type PaymentStatus = keyof typeof PaymentStatus;

export const PaymentMethod = { QRIS: "QRIS", BANK_TRANSFER: "BANK_TRANSFER", COD: "COD", GATEWAY: "GATEWAY" } as const;
export type PaymentMethod = keyof typeof PaymentMethod;

export const ShipmentStatus = { PENDING: "PENDING", RATE_SELECTED: "RATE_SELECTED", PICKED_UP: "PICKED_UP", IN_TRANSIT: "IN_TRANSIT", DELIVERED: "DELIVERED", FAILED: "FAILED" } as const;
export type ShipmentStatus = keyof typeof ShipmentStatus;

export const VoucherType = { FREE_SHIPPING: "FREE_SHIPPING", PERCENTAGE_DISCOUNT: "PERCENTAGE_DISCOUNT", FIXED_DISCOUNT: "FIXED_DISCOUNT" } as const;
export type VoucherType = keyof typeof VoucherType;

// Permissions are data-driven strings (Subject.action), not a Prisma enum.
export type AdminPermission =
  | "Dashboard.read" | "Order.read" | "Order.update"
  | "Payment.read" | "Payment.verify" | "Payment.reject"
  | "Shipment.create" | "Shipment.read" | "Shipment.update" | "Shipment.delete"
  | "User.read" | "User.update" | "Role.create" | "Role.read" | "Role.update"
  | "Product.create" | "Product.read" | "Product.update" | "Product.delete"
  | "Category.create" | "Category.read" | "Category.update" | "Category.delete"
  | "Promo.create" | "Promo.read" | "Promo.update" | "Promo.delete"
  | "Banner.create" | "Banner.read" | "Banner.update" | "Banner.delete";
```

### `models.ts` (mirror schema.prisma columns + includes returned)
```ts
import type { OrderStatus, PaymentStatus, PaymentMethod, ShipmentStatus, VoucherType, AdminPermission } from "./enums";

export interface AuthTokens { accessToken: string; refreshToken: string }
export interface AdminSession { id: string; email: string; name: string; isActive: boolean; permissions: AdminPermission[] }

export interface User { id: string; email: string; name: string; avatarUrl?: string | null; phone?: string | null; isOnboarded: boolean; isActive: boolean; roles?: { role: { name: string } }[]; addresses?: Address[]; createdAt: string }
export interface Address { id: string; userId: string; label: string; recipientName: string; phone: string; fullAddress: string; notes?: string | null; latitude: string; longitude: string; isDefault: boolean }

export interface Product { id: string; slug: string; sku: string; name: string; description: string; price: number; originalPrice?: number | null; imageUrl: string; rating: string; reviewCount: number; spicyLevel?: number | null; isBestSeller: boolean; isNew: boolean; status: "DRAFT" | "ACTIVE" | "ARCHIVED"; stock: number; categoryId: string }
export interface Category { id: string; name: string; slug: string; icon?: string | null; sortOrder: number }
export interface Topping { id: string; name: string; price: number; isActive: boolean }
export interface Promo { id: string; code: string; title: string; description: string; voucherType: VoucherType; discountPercentage?: number | null; discountAmount?: number | null; minimumOrderAmount: number; isActive: boolean }

export interface CheckoutItem { product_id: string; qty: number; topping_ids?: string[]; spicyLevel?: number; notes?: string }
export interface ShippingQuote { shipping_cost: number; estimated_days: string }
export interface VoucherPreview { valid: boolean; discount: number; voucher_type: VoucherType }
export interface CheckoutSummary { subtotal: number; shipping_cost: number; discount: number; grand_total: number; estimated_days?: string; voucher?: Promo | null } // confirm vs getSummary
export interface UploadPage { orderNumber: string; amount: number; method: PaymentMethod; bankName?: string | null; status: PaymentStatus }

export interface OrderItem { id: string; productId: string; productName: string; unitPrice: number; quantity: number; spicyLevel?: number | null; notes?: string | null; toppings: { name: string; price: number }[] }
export interface Payment { id: string; orderId: string; method: PaymentMethod; status: PaymentStatus; amount: number; manualReceiptUrl?: string | null; manualBankName?: string | null; verifiedAt?: string | null; createdAt: string }
export interface Shipment { id: string; orderId: string; provider: string; service: string; status: ShipmentStatus; cost: number; trackingNumber?: string | null; trackingUrl?: string | null }
export interface OrderEvent { id: string; status: OrderStatus; note?: string | null; createdAt: string }
export interface Order {
  id: string; orderNumber: string; userId: string; addressId: string; status: OrderStatus;
  subtotal: number; voucherDiscountAmount: number; deliveryFee: number; totalPrice: number;
  paymentMethod: PaymentMethod; voucherCode?: string | null; estimatedDelivery?: string | null; createdAt: string;
  items?: OrderItem[]; address?: Address; payment?: Payment | null; shipment?: Shipment | null; events?: OrderEvent[];
  user?: { id: string; name: string; email: string; phone?: string | null };
}
```

---

## 4. Query hooks (`lib/query`)

### `keys.ts`
```ts
export const qk = {
  me: ["me"] as const,
  products: (q: unknown) => ["catalog", "products", q] as const,
  product: (idOrSlug: string) => ["catalog", "product", idOrSlug] as const,
  orders: (userId: string, status?: string) => ["orders", userId, status ?? "all"] as const,
  uploadPage: (token: string) => ["payment-upload", token] as const,
  admin: {
    payments: (status?: string) => ["admin", "payments", status ?? "pending"] as const,
    orders: (q: unknown) => ["admin", "orders", q] as const,
    order: (id: string) => ["admin", "order", id] as const,
    me: ["admin", "me"] as const,
  },
};
```

### Hooks
```ts
// useMe.ts
export const useMe = () => useQuery({ queryKey: qk.me, queryFn: authApi.me, retry: false, staleTime: 5 * 60_000 });

// useProducts.ts
export const useProducts = (q: ProductQuery) => useQuery({ queryKey: qk.products(q), queryFn: () => catalogApi.products(q) });

// useCheckout.ts — orchestrates summary + idempotent order
export function useCheckout() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  return useMutation({
    mutationFn: ({ input }: { input: CreateOrderInput }) =>
      checkoutApi.createOrder(input, crypto.randomUUID()), // stable per attempt (store in a ref for retries)
    onSuccess: () => { if (me) qc.invalidateQueries({ queryKey: ["orders", me.id] }); },
  });
}

// useOrders.ts
export const useOrders = (status?: string) => {
  const { data: me } = useMe();
  return useQuery({ queryKey: qk.orders(me?.id ?? "", status), queryFn: () => orderApi.listForUser(me!.id, status), enabled: !!me });
};

// useUploadReceipt.ts — file → url → submit (token or authenticated)
export function useUploadReceipt(mode: "token" | "auth", ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, bankName, accountName }: { file: File; bankName?: string; accountName?: string }) => {
      const { url } = mode === "token" ? await paymentApi.uploadTokenFile(ref, file) : await paymentApi.uploadFile(ref, file);
      return mode === "token"
        ? paymentApi.submitByToken(ref, { receiptUrl: url, bankName, accountName })
        : paymentApi.submitManual(ref, { receiptUrl: url, bankName, accountName });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["orders"] }); if (mode === "token") qc.invalidateQueries({ queryKey: qk.uploadPage(ref) }); },
  });
}

// useAdminPayments.ts
export const useAdminPayments = (status?: PaymentStatus) =>
  useQuery({ queryKey: qk.admin.payments(status), queryFn: () => (status ? adminApi.payments(status) : adminApi.pendingPayments()) });

// useVerifyPayment.ts / useRejectPayment.ts
export function useVerifyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => adminApi.verifyPayment(id, note),
    onSuccess: (_d, { id }) => { qc.invalidateQueries({ queryKey: ["admin", "payments"] }); qc.invalidateQueries({ queryKey: qk.admin.order(id) }); },
  });
}
export function useRejectPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => adminApi.rejectPayment(id, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "payments"] }),
  });
}
```

---

## 5. Route structure & guards
- **Customer (public):** `/login`, `/catalog`, `/product/[slug]`, `/payment/[token]` (tokenized upload landing — no auth).
- **Customer (protected):** `/cart`, `/checkout`, `/orders` → redirect to `/login` if no customer token.
- **Admin (public):** `/admin/login`.
- **Admin (protected):** `/admin/*` → redirect to `/admin/login` if no admin token; per-feature UI gated by `permissions`.

`middleware.ts` reads the token cookies and redirects unauthenticated access; route groups `(storefront)` and `(admin)` give separate shells.

---

## 6. Authentication architecture
**Customer:** Google Identity Services → `idToken` → `POST /auth/google` → `{ accessToken, refreshToken, user }`. Store access (memory + cookie) and refresh (cookie). Client attaches `Bearer access`; on 401 it calls `/auth/refresh` once, swaps tokens, retries; on failure → clear + `/login`.

**Admin:** `POST /admin/auth/login { email, password }` → `{ accessToken, admin }` (admin tokens have no refresh endpoint → on 401, route to `/admin/login`). `GET /admin/auth/me` hydrates `permissions`.

### `lib/auth/tokens.ts`
```ts
import Cookies from "js-cookie";
const K = { access: "ms_access", refresh: "ms_refresh", admin: "ms_admin" };
export const getTokens = () => ({ access: Cookies.get(K.access), refresh: Cookies.get(K.refresh), adminAccess: Cookies.get(K.admin) });
export const setTokens = (t: { access?: string; refresh?: string; adminAccess?: string }) => {
  if (t.access) Cookies.set(K.access, t.access, { sameSite: "lax", secure: true });
  if (t.refresh) Cookies.set(K.refresh, t.refresh, { sameSite: "lax", secure: true });
  if (t.adminAccess) Cookies.set(K.admin, t.adminAccess, { sameSite: "lax", secure: true });
};
export const clearTokens = () => Object.values(K).forEach((k) => Cookies.remove(k));
```
> Hardening note: cookies set by JS aren't `httpOnly`. For production, proxy auth through Next Route Handlers (BFF) that set `httpOnly` cookies.

---

## 7. State management strategy
- **Server state → TanStack Query** (all `*.api.ts` data). `staleTime` 30–60s for catalog; `retry: false` for `me`/auth.
- **Client/UI state → Zustand**: cart (`items`, add/remove/qty — persisted to `localStorage`; backend cart session is create-only), checkout draft (address/courier/voucher), auth user snapshot.
- **Forms → React Hook Form + Zod** (`lib/validation/*`). Resolver = `zodResolver`.
- One `QueryClient` in `app/providers.tsx`, `Toaster` (shadcn `sonner`) mounted there.

---

## 8. Receipt upload flow
```
[Customer has order, payment PENDING/WAITING_VERIFICATION]
  Logged in:    pick image → POST /payments/:id/manual-receipt/file → { url }
                → POST /payments/:id/manual-receipt { receiptUrl:url, bankName?, accountName? }
  Token link:   GET /payments/upload/:token (page data) → pick image
                → POST /payments/upload/:token/file → { url }
                → POST /payments/upload/:token { receiptUrl:url, ... }
  → payment.status = WAITING_VERIFICATION → show "Under review"
Errors: 404 (bad/used token or not owner) · 409 (no longer awaiting) · 400 (invalid receiptUrl)
```
`useUploadReceipt(mode, ref)` encapsulates the two-step file→submit. Never let the user type a URL — always upload through `*/file` so `receiptUrl` passes `@IsAppUploadUrl`.

## 9. Checkout flow
```
cart → select address (GET /users/me/addresses) + courier
  → POST /checkout/shipping-cost      (live delivery fee)
  → POST /checkout/validate-voucher   (optional)
  → POST /checkout/summary            (authoritative totals)
  → generate Idempotency-Key (uuid, kept in a ref across retries)
  → POST /checkout/order  (header Idempotency-Key)  → Order
     201 → route to /orders or /payment landing (non-COD: prompt receipt upload)
     409 (in-progress) → read Retry-After, show "processing…", poll/retry SAME key
     422 → key reused with a different cart (surface a clear error)
     400 → validation/stock/voucher error (map to fields/toast)
```

## 10. Payment verification flow (admin)
```
/admin/payments → useAdminPayments() (default = pending-verification)
  open payment → view manualReceiptUrl + order context (GET /admin/orders/:id)
  Approve → useVerifyPayment({id,note}) → 200 PAID (order→PROCESSING); 409 if already terminal (idempotent replay returns current)
  Reject  → useRejectPayment({id,note}) → 200 FAILED (order→CANCELLED, stock restored)
  invalidate ['admin','payments'] + ['admin','order',id]
```

## 11. Error handling strategy
- All requests throw `ApiError { status, message, body }`.
- Global mapping helper: 400 → form/field or toast(message); 401 → refresh→retry→`/login`; 403 → "no permission"; 404 → empty/notFound view; 409 → contextual ("already processed" / "no longer awaiting"); 422 → checkout key conflict; 429 → "slow down"; 5xx → generic toast + retry.
- TanStack Query `QueryCache.onError` → toast for background failures; mutation `onError` → inline form errors.
- Wrap segments in `error.tsx` (App Router) using `<ErrorState onRetry />`.

## 12. Loading states
- Route `loading.tsx` per segment with shadcn `Skeleton` (product grid, order list, payment table).
- Mutation buttons: `disabled + spinner` while `isPending`; optimistic cart updates only (never optimistic for money/checkout).
- Use Suspense + streaming for catalog; `keepPreviousData` for filtered lists.

## 13. Empty states
- Catalog: "No products match your filters" + clear-filters.
- Cart: "Your cart is empty" + browse CTA.
- Orders: "No orders yet" + shop CTA.
- Admin payments: "No payments awaiting verification" (positive empty).
- Component: `components/common/Empty.tsx` ({ icon, title, description, action }).

## 14. Permission-based UI
```ts
// lib/auth/usePermissions.ts
export function usePermissions() {
  const { data } = useQuery({ queryKey: qk.admin.me, queryFn: authApi.adminMe, retry: false });
  const set = new Set(data?.permissions ?? []);
  const isSuper = data?.permissions?.includes("Role.create" as any); // or detect SUPER_ADMIN role server-side
  return { can: (p: AdminPermission) => isSuper || set.has(p), permissions: data?.permissions ?? [] };
}
```
- Gate nav items and action buttons: `can("Payment.verify")`, `can("Order.update")`, `can("Shipment.create")`, etc.
- Hide vs disable: hide whole sections the admin can't read; disable+tooltip for actions inside a readable section.

## 15. Responsive layout strategy
- **Mobile-first Tailwind**, breakpoints `sm/md/lg/xl`. Storefront: single-column → 2-col (sm) → 3–4-col (lg) product grid; sticky bottom cart bar on mobile.
- Checkout: stacked steps on mobile, two-column (form + sticky summary) on `lg`.
- Admin: collapsible sidebar (shadcn `Sheet` on mobile, fixed rail on `lg`); tables → horizontal scroll on mobile or card list under `md` (`hidden md:table` / `md:hidden` card variant).
- Use shadcn `Dialog`/`Drawer` responsively (Drawer on mobile, Dialog on desktop) for receipt upload & verify modals.

---

## Known backend gaps to design around (from audit)
- **No pagination** on lists yet → render all; build `components/common/Pagination.tsx` ready to wire when `?page/limit` lands.
- **No email/password customer auth** → only Google on `/login`.
- **No cart retrieval API** → persist cart in Zustand/localStorage.
- **No customer single-order GET** → derive detail from the `/orders/users/:id` list payload.
- **`PaymentStatus.FAILED` = "Rejected"** in UI copy.
- Responses are raw Prisma objects → models above may include extra fields; treat unlisted fields as optional.
