'use client'

import { type ComponentType } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, CreditCard, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermissions } from '@/lib/auth/use-permissions'
import type { AdminPermission } from '@/lib/types/enums'

export interface AdminNavItem {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  permission: AdminPermission
}

export const ADMIN_NAV: AdminNavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard, permission: 'Dashboard.read' },
  { label: 'Orders', href: '/admin/orders', icon: ClipboardList, permission: 'Order.read' },
  { label: 'Payments', href: '/admin/payments', icon: CreditCard, permission: 'Payment.read' },
]

/** Permission-aware nav: only renders items the admin is allowed to read. */
export function AdminMenu() {
  const pathname = usePathname()
  const { can } = usePermissions()
  return (
    <nav className="flex flex-col gap-1">
      {ADMIN_NAV.filter((item) => can(item.permission)).map((item) => {
        const Icon = item.icon
        const active = item.href === '/admin' ? pathname === '/admin' : pathname?.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
