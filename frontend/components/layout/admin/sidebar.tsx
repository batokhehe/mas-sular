import { ScrollArea } from '@/components/ui/scroll-area'
import { AdminMenu } from './admin-menu'

export function AdminSidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-muted/30 lg:block">
      <div className="flex h-16 items-center px-5 text-base font-bold">Mas Sular Admin</div>
      <ScrollArea className="h-[calc(100vh-4rem)] px-3 py-2">
        <AdminMenu />
      </ScrollArea>
    </aside>
  )
}
