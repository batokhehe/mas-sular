import Link from 'next/link'

export function StorefrontFooter() {
  return (
    <footer className="border-t bg-secondary/30">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
                BMS
              </span>
              <span className="text-lg font-bold tracking-tight">Bakso Mas Sular</span>
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">
              Premium Indonesian meatballs, delivered fresh to your door.
            </p>
          </div>
          <nav className="flex flex-col gap-2 text-sm">
            <span className="font-semibold">Explore</span>
            <Link href="/catalog" className="text-muted-foreground transition-colors hover:text-foreground">
              Catalog
            </Link>
            <Link href="/orders" className="text-muted-foreground transition-colors hover:text-foreground">
              My orders
            </Link>
            <Link href="/cart" className="text-muted-foreground transition-colors hover:text-foreground">
              Cart
            </Link>
          </nav>
        </div>
        <p className="mt-8 border-t pt-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Bakso Mas Sular. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
