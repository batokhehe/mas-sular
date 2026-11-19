/**
 * Mas Sular brand assets (public/brand). The source of truth is the operator-supplied
 * logo, kept byte-for-byte as mas-sular-logo.png. Every other file is derived from it
 * only by cropping its transparent margin and downscaling - never redrawn or recolored.
 */

export const BRAND_NAME = 'Bakso Mas Sular'

/** The supplied original (960x960, transparent). */
export const BRAND_LOGO_SOURCE = '/brand/mas-sular-logo.png'

/** Header logo: the original cropped to its own bounds, 141x144 (3x the rendered height). */
export const BRAND_HEADER_LOGO = { src: '/brand/mas-sular-logo-header.png', width: 141, height: 144 } as const

/** Storefront favicons/app icons, all derived from BRAND_LOGO_SOURCE. */
export const BRAND_ICONS = {
  ico: '/brand/favicon.ico',
  png: [
    { url: '/brand/favicon-16x16.png', sizes: '16x16' },
    { url: '/brand/favicon-32x32.png', sizes: '32x32' },
    { url: '/brand/favicon-48x48.png', sizes: '48x48' },
    { url: '/brand/icon-192x192.png', sizes: '192x192' },
    { url: '/brand/icon-512x512.png', sizes: '512x512' },
  ],
  apple: { url: '/brand/apple-touch-icon.png', sizes: '180x180' },
} as const

/** Next.js Metadata `icons` for the storefront root layout. */
export function brandIconsMetadata() {
  return {
    icon: [
      { url: BRAND_ICONS.ico, sizes: '16x16 32x32 48x48' },
      ...BRAND_ICONS.png.map((icon) => ({ url: icon.url, sizes: icon.sizes, type: 'image/png' })),
    ],
    shortcut: BRAND_ICONS.ico,
    apple: [{ url: BRAND_ICONS.apple.url, sizes: BRAND_ICONS.apple.sizes, type: 'image/png' }],
  }
}

/** Every public file the brand references (for the asset test). */
export function brandAssetPaths(): string[] {
  return [
    BRAND_LOGO_SOURCE,
    BRAND_HEADER_LOGO.src,
    BRAND_ICONS.ico,
    ...BRAND_ICONS.png.map((icon) => icon.url),
    BRAND_ICONS.apple.url,
  ]
}
