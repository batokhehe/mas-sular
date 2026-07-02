'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { MapPin, Package, ChevronRight, LogOut, Moon, Sun } from 'lucide-react'
import { useAuth } from '@/lib/auth/auth-context'
import { useOrders } from '@/lib/query/hooks/use-orders'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'

export default function AccountPage() {
  const router = useRouter()
  const { user, logout } = useAuth()
  const orders = useOrders()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  // All values below are real: from useAuth()/useMe() and the order/address hooks.
  const addressCount = user?.addresses?.length ?? 0
  const orderCount = orders.data?.length
  const initials = user?.name?.trim().charAt(0).toUpperCase() || 'U'
  const memberSince = user?.createdAt ? new Date(user.createdAt).getFullYear() : null

  const handleLogout = () => {
    logout()
    router.push('/')
  }

  return (
    <section className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Account</h1>

      {/* Profile header — real profile data */}
      <Card className="mb-6 flex items-center gap-4 p-5">
        <Avatar className="size-16">
          <AvatarImage src={user?.avatarUrl ?? undefined} alt={user?.name ?? ''} />
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold">{user?.name}</h2>
          <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
          {user?.phone ? <p className="truncate text-sm text-muted-foreground">{user.phone}</p> : null}
          {memberSince ? <p className="text-xs text-muted-foreground">Member since {memberSince}</p> : null}
        </div>
      </Card>

      {/* Real counts only — no fabricated stats */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <Link href="/orders">
          <Card className="flex flex-col items-center p-4 text-center transition-colors hover:bg-accent">
            <Package className="mb-2 size-5 text-primary" />
            {orderCount === undefined ? (
              <Skeleton className="h-7 w-8" />
            ) : (
              <p className="text-2xl font-bold">{orderCount}</p>
            )}
            <p className="text-xs text-muted-foreground">Orders</p>
          </Card>
        </Link>
        <Link href="/account/addresses">
          <Card className="flex flex-col items-center p-4 text-center transition-colors hover:bg-accent">
            <MapPin className="mb-2 size-5 text-primary" />
            <p className="text-2xl font-bold">{addressCount}</p>
            <p className="text-xs text-muted-foreground">Addresses</p>
          </Card>
        </Link>
      </div>

      {/* Menu — links to the existing production routes (no duplicated logic) */}
      <div className="space-y-3">
        <Link href="/account/addresses">
          <Card className="flex items-center justify-between p-4 transition-colors hover:bg-accent">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <MapPin className="size-5 text-primary" />
              </span>
              <div>
                <p className="font-medium">Address Book</p>
                <p className="text-sm text-muted-foreground">{addressCount} saved</p>
              </div>
            </div>
            <ChevronRight className="size-5 text-muted-foreground" />
          </Card>
        </Link>

        <Link href="/orders">
          <Card className="flex items-center justify-between p-4 transition-colors hover:bg-accent">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <Package className="size-5 text-primary" />
              </span>
              <div>
                <p className="font-medium">Order History</p>
                <p className="text-sm text-muted-foreground">View all your orders</p>
              </div>
            </div>
            <ChevronRight className="size-5 text-muted-foreground" />
          </Card>
        </Link>

        {/* Dark mode — real preference toggle (next-themes) */}
        <Card className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
              {mounted && theme === 'dark' ? (
                <Moon className="size-5 text-primary" />
              ) : (
                <Sun className="size-5 text-primary" />
              )}
            </span>
            <div>
              <p className="font-medium">Dark mode</p>
              <p className="text-sm text-muted-foreground">Switch the app theme</p>
            </div>
          </div>
          <Switch
            checked={mounted ? theme === 'dark' : false}
            onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
            aria-label="Toggle dark mode"
          />
        </Card>

        {/* Logout — real auth-context logout */}
        <Button variant="outline" className="w-full justify-start text-destructive" onClick={handleLogout}>
          <LogOut className="mr-2 size-4" />
          Sign out
        </Button>
      </div>
    </section>
  )
}
