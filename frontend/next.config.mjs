/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the
  // node_modules actually reachable at runtime — the production image copies
  // that instead of installing dependencies again.
  output: 'standalone',
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
  allowedDevOrigins: ['*'],
}

export default nextConfig