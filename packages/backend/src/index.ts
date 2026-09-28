/**
 * Cloudflare Worker entry point.
 * Routes /api/* to the API router; everything else is served from the
 * static assets binding (the built frontend, SPA fallback).
 * SECURITY: This Worker is the only component holding GitHub credentials.
 */

import type { Env } from './env';
import { jsonError } from './core/http';
import { handleApiRequest } from './routes';

/** Main fetch handler for the Worker. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Only /api/* reaches the Worker script (run_worker_first in wrangler.toml);
    // every other path is served from static assets, with unmatched navigation
    // requests falling back to /index.html (SPA routing).
    try {
      if (url.pathname.startsWith('/api')) {
        return await handleApiRequest(url.pathname, request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      // Safety net: an unexpected exception must still answer with the
      // JSON error envelope the frontend expects, not the runtime's
      // plain-text 500.
      console.error('Worker error:', error instanceof Error ? error.message : error);
      return jsonError('internal', 'Internal server error', 500);
    }
  },
};