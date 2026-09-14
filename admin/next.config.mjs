/**
 * Security headers (M6). HSTS is set by the TLS-terminating reverse proxy (nginx),
 * so it is not repeated here. The CSP is only emitted for production builds:
 * `next dev` needs eval/HMR websockets that a strict policy would block.
 */
const isProd = process.env.NODE_ENV === 'production';

/** The API origin the admin talks to (fetch + the SSE EventSource), from the build-time URL. */
function apiOrigin() {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : '';
  } catch {
    return '';
  }
}

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; no third-party script is loaded.
  "script-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${apiOrigin()}`.trim(),
  // Product/banner images and private receipts are served by the API; blob:/data: for previews.
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isProd ? [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }] : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the
  // node_modules actually reachable at runtime — the production image copies
  // that instead of installing dependencies again.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,

  // M6: `allowedDevOrigins: ['*']` was removed. It only affects `next dev`, but a
  // wildcard lets any origin reach the dev server's internal endpoints; the
  // default (same-origin only) is the safe setting.

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3001',
        pathname: '/uploads/**',
      },
    ],
  },
};

export default nextConfig;
