/**
 * Security headers (M6). HSTS is set by the TLS-terminating reverse proxy (nginx),
 * so it is not repeated here. The CSP is only emitted for production builds:
 * `next dev` needs eval/HMR websockets that a strict policy would block.
 */
const isProd = process.env.NODE_ENV === 'production'

/** The API origin the storefront calls, from the build-time URL. */
function apiOrigin() {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : ''
  } catch {
    return ''
  }
}

// Google Identity Services (the "Sign in with Google" button) is the only
// third-party origin the storefront loads: its script, button iframe, stylesheet
// and status XHR all live on accounts.google.com. Midtrans payment is a top-level
// redirect, which CSP does not restrict.
const GOOGLE_ID = 'https://accounts.google.com'

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${GOOGLE_ID}`,
  `connect-src 'self' ${apiOrigin()} ${GOOGLE_ID}`.replace(/\s+/g, ' '),
  `frame-src ${GOOGLE_ID}`,
  `style-src 'self' 'unsafe-inline' ${GOOGLE_ID}`,
  // Product images (API /uploads), Google avatars, and blob: receipt previews.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
  ...(isProd ? [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }] : []),
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the
  // node_modules actually reachable at runtime — the production image copies
  // that instead of installing dependencies again.
  output: 'standalone',
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'staging-api.baksomassular.com',
        pathname: '/uploads/**',
      },
    ],
  },
  // M6: `allowedDevOrigins: ['*']` was removed (wildcard dev-server origin access).

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
