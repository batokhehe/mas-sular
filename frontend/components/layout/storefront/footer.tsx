export function StorefrontFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
        <p>© {new Date().getFullYear()} Baso Nusantara</p>
        <p>Premium Indonesian meatballs, delivered.</p>
      </div>
    </footer>
  )
}
