/** @type {import('next').NextConfig} */
const nextConfig = {
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