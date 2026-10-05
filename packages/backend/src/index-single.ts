/**
 * Entry point for the single-file distribution build (implements.md §5a).
 *
 * Same routing as src/index.ts, except static assets are served from the
 * embedded assets module (bundled by scripts/build-single.mjs via esbuild)
 * instead of the ASSETS binding — the single-file Worker deploys with no
 * assets directory and no [assets] section in its wrangler.toml.
 * SECURITY: unchanged — /api/* goes through the exact same router, and
 * only this Worker ever holds credentials.
 */

import type { Env } from './env';
import { jsonError } from './core/http';
import { handleApiRequest } from './routes';
import { serveEmbedded } from './single/embedded';
import { embeddedAssets } from 'virtual:embedded-assets';

/** Main fetch handler for the single-file Worker. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api')) {
        return await handleApiRequest(url.pathname, request, env);
      }
      return serveEmbedded(request, embeddedAssets);
    } catch (error) {
      // Safety net: an unexpected exception must still answer with the
      // JSON error envelope the frontend expects, not the runtime's
      // plain-text 500.
      console.error('Worker error:', error instanceof Error ? error.message : error);
      return jsonError('internal', 'Internal server error', 500);
    }
  },
};
