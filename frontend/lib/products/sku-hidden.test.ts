import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * P2 #5 — the storefront must never show a product SKU.
 *
 * There is no component-render harness in this package, so this guards the source
 * itself: no storefront file may read `.sku` or render a "SKU" label. Comments are
 * stripped first, so explanatory notes about the rule are allowed. The public
 * catalog API no longer returns `sku` at all (backend product-sku specs), and the
 * customer `Product` type has no `sku` field, so a regression fails to compile too.
 */

const ROOT = process.cwd() // `pnpm test` runs from the frontend package root
const SCANNED = ['app', 'components', 'lib', 'hooks']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full)
  }
  return out
}

const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('no storefront source reads a product SKU or renders a "SKU" label', () => {
  const offenders = SCANNED.flatMap((d) => {
    try {
      return sourceFiles(join(ROOT, d))
    } catch {
      return []
    }
  })
    .filter((file) => /\.sku\b|\bsku\s*[:?]|>\s*SKU\b|['"`]SKU\b/i.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(ROOT, file))
  assert.deepEqual(offenders, [], `SKU must not be exposed on the storefront: ${offenders.join(', ')}`)
})

test('the customer Product type declares no sku field', () => {
  const models = withoutComments(readFileSync(join(ROOT, 'lib/types/models.ts'), 'utf8'))
  const product = models.slice(models.indexOf('export interface Product {'))
  const body = product.slice(0, product.indexOf('\n}'))
  assert.equal(/\bsku\b/.test(body), false)
})
