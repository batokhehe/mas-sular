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
  Soup,
  Plug,
  type LucideIcon,
} from 'lucide-react';

import { useAdminPermissions } from '@/lib/auth';
import { NavIconName, visibleNavSections } from '@/lib/navigation';

// Menu items, their order and their permissions live in lib/navigation.ts (shared
// with the post-login redirect); this component only maps icon names and renders.
const ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  products: Boxes,
  categories: Layers,
  toppings: Soup,
  banners: Image,
  orders: ClipboardList,
  payments: CreditCard,
  shipping: Truck,
  coverage: MapPinned,
  reservations: PackageCheck,
  warehouse: Warehouse,
  store: Store,
  transfer: ArrowLeftRight,
  voucher: Gift,
  users: Users,
  roles: Shield,
  activity: Activity,
  logs: ScrollText,
  requests: SearchCode,
  queues: Inbox,
  performance: Gauge,
  incidents: Siren,
  notifications: BellRing,
  communications: MessagesSquare,
  audit: History,
  integrations: Plug,
};

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

          {visibleNavSections(permissions).map((section) => (
            <div key={section.label}>

              <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {section.label}
              </p>

              <div className="space-y-1">

                {section.items
                  .map((item) => {
                    const Icon = ICONS[item.icon];
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