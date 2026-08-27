'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  Boxes,
  ClipboardList,
  CreditCard,
  Gift,
  Image,
  LayoutDashboard,
  ArrowLeftRight,
  Layers,
  MapPinned,
  PackageCheck,
  Shield,
  Store,
  Truck,
  Users,
  Warehouse,
  ScrollText,
  Activity,
  SearchCode,
  Inbox,
  Gauge,
  Siren,
  BellRing,
  MessagesSquare,
  History,
} from 'lucide-react';

import { useAdminPermissions } from '@/lib/auth';
import { hasAnyPermission } from '@/lib/permissions';
import { ROUTE_PERMISSIONS } from '@/lib/access';

const sections = [
  {
    label: 'Menu',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permissions: ROUTE_PERMISSIONS.dashboard },
      { href: '/products', label: 'Products', icon: Boxes, permissions: ROUTE_PERMISSIONS.products },
      { href: '/categories', label: 'Categories', icon: Layers, permissions: ROUTE_PERMISSIONS.categories },
      { href: '/banners', label: 'Banners', icon: Image, permissions: ROUTE_PERMISSIONS.banners },
      { href: '/orders', label: 'Orders', icon: ClipboardList, permissions: ROUTE_PERMISSIONS.orders },
      { href: '/payments', label: 'Order Verification', icon: CreditCard, permissions: ROUTE_PERMISSIONS.payments },
      { href: '/shipping', label: 'Shipping', icon: Truck, permissions: ROUTE_PERMISSIONS.shipments },
      { href: '/delivery-coverage', label: 'Delivery Coverage', icon: MapPinned, permissions: ROUTE_PERMISSIONS.deliveryCoverage },
      { href: '/inventory-reservations', label: 'Inventory Reservations', icon: PackageCheck, permissions: ROUTE_PERMISSIONS.inventoryReservations },
      { href: '/inventory/products', label: 'Product Inventory', icon: Warehouse, permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/outlets', label: 'Outlet Inventory', icon: Store, permissions: ROUTE_PERMISSIONS.productInventory },
      { href: '/inventory/transfers', label: 'Stock Transfer', icon: ArrowLeftRight, permissions: ROUTE_PERMISSIONS.stockTransfers },
      { href: '/promos', label: 'Voucher', icon: Gift, permissions: ROUTE_PERMISSIONS.promos },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/users', label: 'Users', icon: Users, permissions: ROUTE_PERMISSIONS.users },
      { href: '/roles', label: 'Roles & Permissions', icon: Shield, permissions: ROUTE_PERMISSIONS.roles },
      { href: '/payment-accounts', label: 'Payment Accounts', icon: CreditCard, permissions: ROUTE_PERMISSIONS.paymentAccounts },
      { href: '/outlets', label: 'Outlet Configuration', icon: Store, permissions: ROUTE_PERMISSIONS.outlets },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/system/dashboard', label: 'Dashboard', icon: Activity, permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/logs', label: 'Logs', icon: ScrollText, permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/requests', label: 'Request Explorer', icon: SearchCode, permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/queues', label: 'Queue Center', icon: Inbox, permissions: ROUTE_PERMISSIONS.queues },
      { href: '/system/performance', label: 'Performance', icon: Gauge, permissions: ROUTE_PERMISSIONS.systemLogs },
      { href: '/system/incidents', label: 'Incidents', icon: Siren, permissions: ROUTE_PERMISSIONS.incidents },
      { href: '/system/notifications', label: 'Notification Center', icon: BellRing, permissions: ROUTE_PERMISSIONS.notifications },
      { href: '/system/communications', label: 'Customer Communications', icon: MessagesSquare, permissions: ROUTE_PERMISSIONS.communications },
      { href: '/system/audit', label: 'Audit Trail', icon: History, permissions: ROUTE_PERMISSIONS.audit },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const permissions = useAdminPermissions();

  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [pathname]);

  const isActive = (href: string) => {
    if (href === '/dashboard') {
      return pathname === '/dashboard';
    }

    return pathname.startsWith(href);
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-[290px] border-r border-gray-200 bg-white md:flex md:flex-col">

      {/* Header */}
      <div className="flex h-16 shrink-0 items-center border-b border-gray-200 px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#465fff] font-bold text-white">
          BMS
        </div>

        <div className="ml-3">
          <div className="font-semibold text-gray-900">
            Bakso Mas Sular
          </div>

          <div className="text-xs text-gray-500">
            Admin CMS
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        <nav className="space-y-6 p-4">

          {sections.map((section) => (
            <div key={section.label}>

              <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {section.label}
              </p>

              <div className="space-y-1">

                {section.items
                  .filter((item) =>
                    hasAnyPermission(permissions, item.permissions),
                  )
                  .map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.href);

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        ref={active ? activeRef : undefined}
                        className={[
                          'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',

                          active
                            ? 'bg-indigo-50 text-[#465fff]'
                            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                        ].join(' ')}
                      >
                        <Icon className="h-5 w-5 shrink-0" />

                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
              </div>
            </div>
          ))}

        </nav>
      </div>
    </aside>
  );
}