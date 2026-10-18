/**
 * Next.js 15 (App Router) + React 19 + TypeScript.
 *
 * El navegador habla siempre en mismo origen: las llamadas a `/api/*`
 * se reescriben al backend, por lo que no se necesita CORS.
 */
import type { NextConfig } from 'next';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
