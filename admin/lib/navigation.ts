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
      { href: DASHBOARD_ROUTE, label: 'Dashboard', icon: 'dashboard', permissions: ROUTE_PERMISSIONS.dashboard },
      { href: '/products', label: 'Products', icon: 'products', permissions: ROUTE_PERMISSIONS.products },
      { href: '/categories', label: 'Categories', icon: 'categories', permissions: ROUTE_PERMISSIONS.categories },
      { href: '/toppings', label: 'Toppings', icon: 'toppings', permissions: ROUTE_PERMISSIONS.toppings },
      { href: '/banners', label: 'Banners', icon: 'banners', permissions: ROUTE_PERMISSIONS.banners },
      { href: '/orders', label: 'Orders', icon: 'orders', permissions: ROUTE_PERMISSIONS.orders },
      { href: '/payments', label: 'Order Verification', icon: 'payments', permissions: ROUTE_PERMISSIONS.payments },
      { href: '/shipping', label: 'Shipping', icon: 'shipping', permissions: ROUTE_PERMISSIONS.shipments },
      { href: '/delivery-coverage', label: 'Delivery Coverage', icon: 'coverage', permissions: ROUTE_PERMISSIONS.deliveryCoverage },
      { href: '/inventory-reservations', label: 'Inventory Reservations', icon: 'reservations', permissions: ROUTE_PERMISSIONS.inventoryReservations },
      { href: '/inventory/products', label: 'Product Inventory', icon: 'warehouse', permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/outlets', label: 'Outlet Inventory', icon: 'store', permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/transfers', label: 'Stock Transfer', icon: 'transfer', permissions: ROUTE_PERMISSIONS.stockTransfers },
      { href: '/promos', label: 'Voucher', icon: 'voucher', permissions: ROUTE_PERMISSIONS.promos },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/users', label: 'Users', icon: 'users', permissions: ROUTE_PERMISSIONS.users },
      { href: '/roles', label: 'Roles & Permissions', icon: 'roles', permissions: ROUTE_PERMISSIONS.roles },
      { href: '/payment-accounts', label: 'Payment Accounts', icon: 'payments', permissions: ROUTE_PERMISSIONS.paymentAccounts },
      { href: '/outlets', label: 'Outlet Configuration', icon: 'store', permissions: ROUTE_PERMISSIONS.outlets },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/system/dashboard', label: 'Dashboard', icon: 'activity', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/logs', label: 'Logs', icon: 'logs', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/integration-logs', label: 'Integration Logs', icon: 'integrations', permissions: ROUTE_PERMISSIONS.integrationLogs },
      { href: '/system/requests', label: 'Request Explorer', icon: 'requests', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/queues', label: 'Queue Center', icon: 'queues', permissions: ROUTE_PERMISSIONS.queues },
      { href: '/system/performance', label: 'Performance', icon: 'performance', permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/incidents', label: 'Incidents', icon: 'incidents', permissions: ROUTE_PERMISSIONS.incidents },
      { href: '/system/notifications', label: 'Notification Center', icon: 'notifications', permissions: ROUTE_PERMISSIONS.notifications },
      { href: '/system/communications', label: 'Customer Communications', icon: 'communications', permissions: ROUTE_PERMISSIONS.communications },
      { href: '/system/audit', label: 'Audit Trail', icon: 'audit', permissions: ROUTE_PERMISSIONS.audit },
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
