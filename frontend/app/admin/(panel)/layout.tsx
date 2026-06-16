import { type ReactNode } from 'react'
import { RequireAdmin } from '@/components/auth/require-admin'
import { AdminSidebar } from '@/components/layout/admin/sidebar'
import { AdminTopbar } from '@/components/layout/admin/topbar'

// Admin shell + guard for every panel route (NOT /admin/login, which sits
// outside this route group).
export default function AdminPanelLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAdmin>
      <div className="flex min-h-screen bg-background">
        <AdminSidebar />
        <div className="flex flex-1 flex-col">
          <AdminTopbar />
          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </RequireAdmin>
  )
}
