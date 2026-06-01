import { api } from './api';

export type AdminCategory = {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  icon?: string | null;
};

export type AdminProduct = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  originalPrice?: number | null;
  categoryId: string;
  stock: number;
  status: string;
  isBestSeller: boolean;
  isNew: boolean;
  price: number;
  spicyLevel?: number | null;
  createdAt: string;
};

export type AdminPromo = {
  id: string;
  code: string;
  title: string;
  description: string;
  imageUrl?: string | null;
  voucherType: 'FREE_SHIPPING' | 'PERCENTAGE_DISCOUNT' | 'FIXED_DISCOUNT';
  discountPercentage?: number | null;
  discountAmount?: number | null;
  maxDiscountAmount?: number | null;
  freeShippingMaxAmount?: number | null;
  minimumOrderAmount: number;
  maxUsageCount?: number | null;
  currentUsageCount: number;
  isNewUserOnly: boolean;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
};

export type AdminBanner = {
  id: string;
  title: string;
  description?: string | null;
  placement: string;
  imageUrl: string;
  href?: string | null;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  createdAt: string;
};

export type AdminDashboard = {
  ordersToday: number;
  totalOrders: number;
  totalUsers: number;
  pendingOrders: number;
  verifiedOrders: number;
  totalRevenue: number;
  pendingPayments: number;
  activeProducts: number;
  lowStockProducts: number;
  totalVouchers: number;
  activeVouchers: number;
  expiredVouchers: number;
  totalRedemptions: number;
  topUsedVouchers: Array<{ voucherId: string; code: string; title: string; redemptions: number }>;
  ordersByStatus: Record<string, number>;
};

export type AdminOrder = {
  id: string;
  orderNumber: string;
  status: string;
  totalPrice: number;
  paymentMethod: string;
  createdAt: string;
  user?: {
    name: string;
    email: string;
    phone?: string | null;
  };
  payment?: {
    id: string;
    status: string;
    amount: number;
    manualReceiptUrl?: string | null;
  } | null;
  shipment?: {
    id: string;
    provider: string;
    service: string;
    status: string;
    trackingNumber?: string | null;
  } | null;
};

export type AdminPayment = {
  id: string;
  status: string;
  amount: number;
  method: string;
  manualBankName?: string | null;
  manualAccountName?: string | null;
  manualReceiptUrl?: string | null;
  createdAt: string;
  order: AdminOrder;
};

export type AdminShipment = {
  id: string;
  provider: string;
  service: string;
  status: string;
  cost: number;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  order: AdminOrder;
};

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  isActive: boolean;
  roles: Array<{ role: { id: string; name: string } }>;
  createdAt: string;
};

export type AdminUserDetail = AdminUser & {
  addresses: Array<{
    id: string;
    label: string;
    recipientName: string;
    phone: string;
    fullAddress: string;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    totalPrice: number;
    createdAt: string;
  }>;
};

export type AdminRole = {
  id: string;
  name: string;
  description?: string | null;
  permissions: Array<{ permission: { id: string; action: string; subject: string } }>;
};

export function fetchAdminUsers() {
  return api<AdminUser[]>('/admin/users');
}

export function fetchAdminUser(id: string) {
  return api<AdminUserDetail>(`/admin/users/${id}`);
}

export function updateAdminUser(id: string, input: Partial<{ isActive: boolean; roleIds: string[] }>) {
  return api<AdminUserDetail>(`/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function fetchAdminRoles() {
  return api<AdminRole[]>('/admin/roles');
}

export function fetchAdminRole(id: string) {
  return api<AdminRole>(`/admin/roles/${id}`);
}

export function createAdminRole(input: { name: string; description?: string; permissionIds?: string[] }) {
  return api<AdminRole>('/admin/roles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminRole(id: string, input: Partial<{ name: string; description?: string | null; permissionIds: string[] }>) {
  return api<AdminRole>(`/admin/roles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function fetchAdminPermissions() {
  return api<Array<{ id: string; action: string; subject: string }>>('/admin/permissions');
}

export function fetchAdminCategories() {
  return api<AdminCategory[]>('/admin/catalog/categories');
}

export function fetchAdminCategory(id: string) {
  return api<AdminCategory>(`/admin/catalog/categories/${id}`);
}

export function createAdminCategory(input: Partial<AdminCategory>) {
  return api<AdminCategory>('/admin/catalog/categories', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminCategory(id: string, input: Partial<AdminCategory>) {
  return api<AdminCategory>(`/admin/catalog/categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminCategory(id: string) {
  return api<void>(`/admin/catalog/categories/${id}`, {
    method: 'DELETE',
  });
}

export function fetchAdminProducts() {
  return api<AdminProduct[]>('/admin/catalog/products');
}

export function fetchAdminPromos() {
  return api<AdminPromo[]>('/admin/catalog/promos');
}

export function fetchAdminBanners() {
  return api<AdminBanner[]>('/admin/cms/banners');
}

export function fetchAdminBanner(id: string) {
  return api<AdminBanner>(`/admin/cms/banners/${id}`);
}

export function createAdminBanner(input: Partial<AdminBanner>) {
  return api<AdminBanner>('/admin/cms/banners', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminBanner(id: string, input: Partial<AdminBanner>) {
  return api<AdminBanner>(`/admin/cms/banners/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminBanner(id: string) {
  return api<void>(`/admin/cms/banners/${id}`, {
    method: 'DELETE',
  });
}

export function fetchAdminDashboard() {
  return api<AdminDashboard>('/admin/dashboard');
}

export function fetchAdminOrders() {
  return api<AdminOrder[]>('/admin/orders');
}

export function fetchAdminPendingPayments() {
  return api<AdminPayment[]>('/admin/payments/pending-verification');
}

export function verifyAdminPayment(paymentId: string) {
  return api<AdminPayment>(`/admin/payments/${paymentId}/verify`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
}

export function rejectAdminPayment(paymentId: string) {
  return api<AdminPayment>(`/admin/payments/${paymentId}/reject`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
}

export function fetchAdminShipments() {
  return api<AdminShipment[]>('/admin/shipments');
}

export type AdminOrderDetail = AdminOrder & {
  address?: {
    id: string;
    label: string;
    recipientName: string;
    phone: string;
    fullAddress: string;
  };
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    spicyLevel?: number | null;
    notes?: string | null;
    toppings: Array<{ id: string; name: string; price: number }>;
  }>;
  payment?: {
    id: string;
    status: string;
    amount: number;
    method: string;
    manualReceiptUrl?: string | null;
    transactions: Array<{ id: string; status: string; amount: number; createdAt: string }>;
  } | null;
  shipment?: {
    id: string;
    provider: string;
    service: string;
    status: string;
    cost: number;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
  } | null;
  events: Array<{ id: string; status: string; note?: string | null; createdAt: string }>;
};

export function fetchAdminOrder(id: string) {
  return api<AdminOrderDetail>(`/admin/orders/${id}`);
}

export function updateAdminOrderStatus(id: string, status: string, note?: string) {
  return api<AdminOrderDetail>(`/admin/orders/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, note }),
  });
}

export function fetchAdminProduct(id: string) {
  return api<AdminProduct>(`/admin/catalog/products/${id}`);
}

export function createAdminProduct(input: Partial<AdminProduct>) {
  return api<AdminProduct>('/admin/catalog/products', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminProduct(id: string, input: Partial<AdminProduct>) {
  return api<AdminProduct>(`/admin/catalog/products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminProduct(id: string) {
  return api<void>(`/admin/catalog/products/${id}`, {
    method: 'DELETE',
  });
}

export function fetchAdminPromo(id: string) {
  return api<AdminPromo>(`/admin/catalog/promos/${id}`);
}

export function createAdminPromo(input: Partial<AdminPromo>) {
  return api<AdminPromo>('/admin/catalog/promos', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminPromo(id: string, input: Partial<AdminPromo>) {
  return api<AdminPromo>(`/admin/catalog/promos/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminPromo(id: string) {
  return api<void>(`/admin/catalog/promos/${id}`, {
    method: 'DELETE',
  });
}

export function fetchAdminShipment(id: string) {
  return api<AdminShipment>(`/admin/shipments/${id}`);
}

export type AdminShipmentCreateInput = {
  orderId: string;
  provider: string;
  service: string;
  cost: number;
  status?: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
};

export function createAdminShipment(input: AdminShipmentCreateInput) {
  return api<AdminShipment>('/admin/shipments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminShipment(id: string, input: Partial<AdminShipmentCreateInput>) {
  return api<AdminShipment>(`/admin/shipments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminShipment(id: string) {
  return api<void>(`/admin/shipments/${id}`, {
    method: 'DELETE',
  });
}
