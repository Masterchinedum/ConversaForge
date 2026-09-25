import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';

/**
 * Content-Security-Policy. Next.js App Router emits inline bootstrap scripts, so script-src keeps
 * 'unsafe-inline' (a nonce-based policy via middleware is a possible hardening step); the policy still
 * blocks third-party script origins, plugins, <base> hijacking, form exfiltration and framing.
 */
function csp({ embed }) {
  const dev = process.env.NODE_ENV !== 'production';
  const ws = process.env.NEXT_PUBLIC_API_WS_URL || '';
  const apiOrigins = [];
  if (ws) {
    try {
      const u = new URL(ws);
      apiOrigins.push(u.origin, u.origin.replace(/^ws/, 'http'));
    } catch {
      /* ignore malformed value */
    }
  }
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", 'blob:', ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', ...apiOrigins.filter((o) => o.startsWith('http'))],
    // Signed media URLs may point at the API origin or an S3/R2 bucket (https).
    'media-src': ["'self'", 'blob:', 'data:', 'https:', ...apiOrigins.filter((o) => o.startsWith('http'))],
    // WebSocket to the API, and OpenAI Realtime SDP exchange for speech-to-speech mode.
    'connect-src': ["'self'", ...apiOrigins, 'https://api.openai.com', ...(dev ? ['ws:', 'http://localhost:*'] : ['wss:'])],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ["'self'", 'blob:', 'https:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': embed ? ['*'] : ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${[...new Set(v)].join(' ')}`)
    .join('; ');
}

const nextConfig = {
  // Separate build dirs let several dev servers run side by side (NEXT_DIST_DIR=.next-foo).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  transpilePackages: ['@cf/shared'],
  poweredByHeader: false,
  experimental: {
    // The /api/* rewrite proxy buffers request bodies and truncates them at 10 MB by default, which
    // breaks uploads (knowledge documents up to 25 MB, course assets up to 200 MB). The API enforces
    // the real per-endpoint limits.
    middlewareClientMaxBodySize: '210mb',
  },
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
      {
        source: '/((?!embed).*)',
        headers: [...security, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }, { key: 'Content-Security-Policy', value: csp({ embed: false }) }],
      },
      // Embed pages can be framed by any site; access is controlled by tokens + allowed origins.
      {
        source: '/embed/:path*',
        headers: [
          ...security.filter((h) => h.key !== 'Permissions-Policy'),
          { key: 'Permissions-Policy', value: 'camera=*, microphone=*' },
          { key: 'Content-Security-Policy', value: csp({ embed: true }) },
        ],
      },
    ];
  },
};

export default nextConfig;
