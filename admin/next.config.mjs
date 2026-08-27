/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the
  // node_modules actually reachable at runtime — the production image copies
  // that instead of installing dependencies again.
  output: 'standalone',
  reactStrictMode: true,

  allowedDevOrigins: ['*'],

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