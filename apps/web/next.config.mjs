import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';

const nextConfig = {
  // Separate build dirs let several dev servers run side by side (NEXT_DIST_DIR=.next-foo).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  transpilePackages: ['@cf/shared'],
  poweredByHeader: false,
  // No server-side image optimization (avoids the native sharp/libvips dependency).
  images: { unoptimized: true },
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // Trace workspace packages from the monorepo root for standalone builds.
  outputFileTracingRoot: path.join(here, '../../'),
  async rewrites() {
    // Same-origin proxy so the httpOnly session cookie works without CORS.
    return [
      { source: '/api/:path*', destination: `${API}/api/:path*` },
      { source: '/health', destination: `${API}/health` },
    ];
  },
  async headers() {
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
    ];
    return [
      // Everything except the embed route may not be framed.
      { source: '/((?!embed).*)', headers: [...security, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
      // Embed pages can be framed by any site; access is controlled by tokens + allowed origins.
      { source: '/embed/:path*', headers: [...security, { key: 'Permissions-Policy', value: 'camera=*, microphone=*' }] },
    ];
  },
};

export default nextConfig;
