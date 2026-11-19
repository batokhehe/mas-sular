import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND_HEADER_LOGO,
  BRAND_ICONS,
  BRAND_LOGO_SOURCE,
  BRAND_NAME,
  brandAssetPaths,
  brandIconsMetadata,
} from './brand-assets.ts'

const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public')
const file = (url: string) => join(PUBLIC_DIR, url.replace(/^\//, ''))

/** SHA-256 of the logo the operator attached (the brand source of truth). */
const SUPPLIED_LOGO_SHA256 = '766c0cbfb4d64889e03ecb7d8e5ee6324fd19c7cb46ca7ccb89ed318d4121e36'

/** PNG IHDR: width, height and colour type (6 = RGBA, i.e. transparency kept). */
function pngInfo(path: string) {
  const buf = readFileSync(path)
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${path} is not a PNG`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf.readUInt8(25) }
}

test('every referenced brand file exists in public/ (so it ships in the production build)', () => {
  for (const url of brandAssetPaths()) assert.ok(existsSync(file(url)), `missing ${url}`)
})

test('the source logo is the supplied file, byte for byte', () => {
  const sha = createHash('sha256').update(readFileSync(file(BRAND_LOGO_SOURCE))).digest('hex')
  assert.equal(sha, SUPPLIED_LOGO_SHA256)
})

test('every derived PNG keeps transparency (RGBA) and has its declared size', () => {
  for (const icon of [...BRAND_ICONS.png, BRAND_ICONS.apple]) {
    const [w, h] = icon.sizes.split('x').map(Number)
    const info = pngInfo(file(icon.url))
    assert.deepEqual([info.width, info.height], [w, h], icon.url)
    assert.equal(info.colorType, 6, `${icon.url} must keep its alpha channel`)
  }
  const header = pngInfo(file(BRAND_HEADER_LOGO.src))
  assert.deepEqual([header.width, header.height], [BRAND_HEADER_LOGO.width, BRAND_HEADER_LOGO.height])
  assert.equal(header.colorType, 6)
})

test('favicon.ico is a real ICO holding 16/32/48 images', () => {
  const ico = readFileSync(file(BRAND_ICONS.ico))
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1) // type: icon
  const count = ico.readUInt16LE(4)
  const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16))
  assert.deepEqual(sizes, [16, 32, 48])
})

test('metadata icons point at the brand files (favicon, PNG sizes, apple touch icon)', () => {
  const icons = brandIconsMetadata()
  const urls = icons.icon.map((i) => i.url)
  assert.ok(urls.includes(BRAND_ICONS.ico))
  for (const png of BRAND_ICONS.png) assert.ok(urls.includes(png.url), png.url)
  assert.equal(icons.apple[0].url, BRAND_ICONS.apple.url)
  for (const url of [...urls, icons.apple[0].url]) assert.ok(existsSync(file(url)), `broken icon path ${url}`)
})

test('the storefront header shows the logo (alt "Bakso Mas Sular") instead of the BMS text', () => {
  const header = readFileSync(join(import.meta.dirname, '..', '..', 'components', 'layout', 'storefront', 'header.tsx'), 'utf8')
  assert.equal(BRAND_NAME, 'Bakso Mas Sular')
  assert.match(header, /src=\{BRAND_HEADER_LOGO\.src\}/)
  assert.match(header, /alt=\{BRAND_NAME\}/)
  assert.match(header, /object-contain/)
  assert.match(header, /<Link href="\/"/)
  assert.doesNotMatch(header, />\s*BMS\s*</)
})

test('the root layout registers the brand icons', () => {
  const layout = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'layout.tsx'), 'utf8')
  assert.match(layout, /icons: brandIconsMetadata\(\)/)
})
