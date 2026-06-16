'use client'

import { Menu, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { usePermissions } from '@/lib/auth/use-permissions'
import { useAuth } from '@/lib/auth/auth-context'
import { AdminMenu } from './admin-menu'

export function AdminTopbar() {
  const { admin } = usePermissions()
  const { adminLogout } = useAuth()

  return (
    <header className="flex h-16 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-4">
            <SheetTitle className="mb-4">Mas Sular Admin</SheetTitle>
            <AdminMenu />
          </SheetContent>
        </Sheet>
        <span className="text-sm text-muted-foreground">{admin?.name ?? 'Admin'}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void adminLogout()}>
        <LogOut className="mr-2 size-4" />
        Sign out
      </Button>
    </header>
  )
}
