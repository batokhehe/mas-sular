import { ROUTE_PERMISSIONS } from './access';
import { hasAllPermissions, hasAnyPermission } from './permissions';

/**
 * The admin panel's navigation - single source for the sidebar AND for where an
 * admin lands after signing in. Permissions come from ROUTE_PERMISSIONS (the same
 * map every page's AdminShell guard uses); nothing is re-spelled here.
 *
 * Icons are referenced by name so this module stays free of React/UI imports; the
 * sidebar maps each name to its lucide icon.
 */

export type NavIconName =
  | 'dashboard' | 'products' | 'categories' | 'toppings' | 'banners' | 'orders' | 'payments' | 'shipping'
  | 'coverage' | 'reservations' | 'warehouse' | 'store' | 'transfer' | 'voucher'
  | 'users' | 'roles' | 'activity' | 'logs' | 'requests' | 'queues' | 'performance'
  | 'incidents' | 'notifications' | 'communications' | 'audit' | 'integrations';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  permissions: readonly string[];
}

export interface NavSection {
  label: string;
  items: readonly NavItem[];
}

export const DASHBOARD_ROUTE = '/dashboard';

export const ADMIN_NAV_SECTIONS: readonly NavSection[] = [
  {
    label: 'Menu',
    items: [
      { href: DASHBOARD_ROUTE, label: 'Dasbor', icon: 'dashboard', permissions: ROUTE_PERMISSIONS.dashboard },
      { href: '/products', label: 'Produk', icon: 'products', permissions: ROUTE_PERMISSIONS.products },
      { href: '/categories', label: 'Kategori', icon: 'categories', permissions: ROUTE_PERMISSIONS.categories },
      { href: '/toppings', label: 'Topping', icon: 'toppings', permissions: ROUTE_PERMISSIONS.toppings },
      { href: '/banners', label: 'Banner', icon: 'banners', permissions: ROUTE_PERMISSIONS.banners },
      { href: '/orders', label: 'Pesanan', icon: 'orders', permissions: ROUTE_PERMISSIONS.orders },
      { href: '/payments', label: 'Verifikasi Pesanan', icon: 'payments', permissions: ROUTE_PERMISSIONS.payments },
      { href: '/shipping', label: 'Pengiriman', icon: 'shipping', permissions: ROUTE_PERMISSIONS.shipments },
      { href: '/delivery-coverage', label: 'Jangkauan Pengiriman', icon: 'coverage', permissions: ROUTE_PERMISSIONS.deliveryCoverage },
      { href: '/inventory-reservations', label: 'Reservasi Stok', icon: 'reservations', permissions: ROUTE_PERMISSIONS.inventoryReservations },
      { href: '/inventory/products', label: 'Stok Produk', icon: 'warehouse', permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/outlets', label: 'Stok Outlet', icon: 'store', permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/transfers', label: 'Transfer Stok', icon: 'transfer', permissions: ROUTE_PERMISSIONS.stockTransfers },
      { href: '/promos', label: 'Voucher', icon: 'voucher', permissions: ROUTE_PERMISSIONS.promos },
    ],
  },
  {
    label: 'Administrasi',
    items: [
      { href: '/users', label: 'Pengguna', icon: 'users', permissions: ROUTE_PERMISSIONS.users },
      { href: '/roles', label: 'Peran & Izin', icon: 'roles', permissions: ROUTE_PERMISSIONS.roles },
      { href: '/payment-accounts', label: 'Rekening Pembayaran', icon: 'payments', permissions: ROUTE_PERMISSIONS.paymentAccounts },
      { href: '/outlets', label: 'Konfigurasi Outlet', icon: 'store', permissions: ROUTE_PERMISSIONS.outlets },
    ],
  },
  {
    label: 'Sistem',
    items: [
      { href: '/system/dashboard', label: 'Dasbor', icon: 'activity', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/logs', label: 'Log', icon: 'logs', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/integration-logs', label: 'Log Integrasi', icon: 'integrations', permissions: ROUTE_PERMISSIONS.integrationLogs },
      { href: '/system/requests', label: 'Penjelajah Request', icon: 'requests', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/queues', label: 'Pusat Antrean', icon: 'queues', permissions: ROUTE_PERMISSIONS.queues },
      { href: '/system/performance', label: 'Performa', icon: 'performance', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/incidents', label: 'Insiden', icon: 'incidents', permissions: ROUTE_PERMISSIONS.incidents },
      { href: '/system/notifications', label: 'Pusat Notifikasi', icon: 'notifications', permissions: ROUTE_PERMISSIONS.notifications },
      { href: '/system/communications', label: 'Komunikasi Pelanggan', icon: 'communications', permissions: ROUTE_PERMISSIONS.communications },
      { href: '/system/audit', label: 'Jejak Audit', icon: 'audit', permissions: ROUTE_PERMISSIONS.audit },
    ],
  },
];

/** Sidebar filtering, unchanged: an item is listed when the admin holds ANY of its permissions. */
export function visibleNavSections(permissions: readonly string[] | null | undefined): NavSection[] {
  return ADMIN_NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => hasAnyPermission(permissions, item.permissions)),
  }));
}

/** Whether the admin may open the executive dashboard (and so request its data). */
export function canViewDashboard(permissions: readonly string[] | null | undefined): boolean {
  return hasAllPermissions(permissions, ROUTE_PERMISSIONS.dashboard);
}

/**
 * Where to put an admin after sign-in (and when they reach a page they may not open).
 * The dashboard first; otherwise the operational pages staff live in; otherwise the
 * first page in sidebar order whose guard the admin passes. Uses the page guard's own
 * rule (ALL of the item's permissions). Falls back to the dashboard only when the
 * admin can open nothing at all - there AdminShell explains that access is missing.
 */
const LANDING_PREFERENCE = [DASHBOARD_ROUTE, '/orders', '/payments', '/shipping'];

export function firstAccessibleRoute(permissions: readonly string[] | null | undefined): string {
  const items = ADMIN_NAV_SECTIONS.flatMap((section) => section.items);
  const preferred = LANDING_PREFERENCE.map((href) => items.find((item) => item.href === href)).filter((item): item is NavItem => !!item);
  const match = [...preferred, ...items].find((item) => hasAllPermissions(permissions, item.permissions));
  return match?.href ?? DASHBOARD_ROUTE;
}
