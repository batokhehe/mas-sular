import Link from 'next/link';
import {
  BarChart3,
  Boxes,
  ClipboardList,
  CreditCard,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  ReceiptText,
  Shield,
  Truck,
  Users,
} from 'lucide-react';

const sections = [
  {
    label: 'Menu',
    items: [
      { href: '/dashboard', label: 'Ecommerce', icon: LayoutDashboard, active: true },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/products', label: 'Products', icon: Boxes },
      { href: '/orders', label: 'Orders', icon: ClipboardList },
      { href: '/payments', label: 'Transactions', icon: CreditCard },
      { href: '/shipping', label: 'Logistics', icon: Truck },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/users', label: 'Users', icon: Users },
      { href: '/roles', label: 'Roles & Permissions', icon: Shield },
      { href: '/cms', label: 'Content CMS', icon: FileText },
      { href: '/audit-logs', label: 'Audit Logs', icon: ReceiptText },
    ],
  },
  {
    label: 'Support',
    items: [{ href: '/orders', label: 'Customer Support', icon: LifeBuoy }],
  },
];

export function Sidebar() {
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
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                      item.active ? 'bg-indigo-50 text-[#465fff]' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
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
