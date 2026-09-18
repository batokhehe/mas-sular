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
              Bakso premium khas Indonesia, dikirim segar sampai ke rumah Anda.
            </p>
          </div>
          <nav className="flex flex-col gap-2 text-sm">
            <span className="font-semibold">Jelajahi</span>
            <Link href="/catalog" className="text-muted-foreground transition-colors hover:text-foreground">
              Katalog
            </Link>
            <Link href="/orders" className="text-muted-foreground transition-colors hover:text-foreground">
              Pesanan Saya
            </Link>
            <Link href="/cart" className="text-muted-foreground transition-colors hover:text-foreground">
              Keranjang
            </Link>
          </nav>
        </div>
        <p className="mt-8 border-t pt-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Bakso Mas Sular. Hak cipta dilindungi.
        </p>
      </div>
    </footer>
  )
}
