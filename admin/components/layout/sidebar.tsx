'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  ClipboardList,
  CreditCard,
  Gift,
  Image,
  LayoutDashboard,
  Layers,
  Shield,
  Truck,
  Users,
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
      { href: '/promos', label: 'Voucher', icon: Gift, permissions: ROUTE_PERMISSIONS.promos },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/users', label: 'Users', icon: Users, permissions: ROUTE_PERMISSIONS.users },
      { href: '/roles', label: 'Roles & Permissions', icon: Shield, permissions: ROUTE_PERMISSIONS.roles },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const permissions = useAdminPermissions();

  const isActive = (href: string) => {
    if (href === '/dashboard') {
      return pathname === '/dashboard';
    }
    return pathname.startsWith(href);
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-[290px] border-r border-gray-200 bg-white md:block">
      <div className="flex h-16 items-center border-b border-gray-200 px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#465fff] font-bold text-white">BN</div>
        <div className="ml-3">
          <span className="block font-semibold text-gray-900">Baso Nusantara</span>
          <span className="text-xs text-gray-500">Admin CMS</span>
        </div>
      </div>
      <nav className="space-y-6 p-4">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">{section.label}</p>
            <div className="space-y-1">
              {section.items.filter((item) => hasAnyPermission(permissions, item.permissions)).map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                      active ? 'bg-indigo-50 text-[#465fff]' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                    ].join(' ')}
                  >
                    <Icon className="h-5 w-5" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
        <div className="rounded-2xl bg-gray-50 p-4">
          <p className="text-sm font-semibold text-gray-800">Manual Payments</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">17 transfer receipts need verification today.</p>
        </div>
      </nav>
    </aside>
  );
}
