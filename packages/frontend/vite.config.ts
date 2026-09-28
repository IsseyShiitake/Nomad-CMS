import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Adjusts the page's Content-Security-Policy per environment.
 *
 * Development: @vitejs/plugin-react injects its Fast Refresh preamble as an
 * inline <script>, which violates `script-src 'self'`, so the meta tag is
 * relaxed to allow inline scripts (dev server only).
 *
 * Production: a split-domain deployment points `VITE_API_BASE_URL` at a
 * cross-origin Worker, which `connect-src 'self'` would block. When an API
 * origin is configured, it is appended to `connect-src` in the built
 * `index.html` and in the `_headers` file (honored by Workers Static Assets,
 * which carries a `CMS_API_ORIGIN` placeholder consumed at build time).
 *
 * The `_headers` CSP is REGENERATED from the built index.html's meta tag, so
 * the two can never drift: index.html is the single source of truth (it also
 * carries `form-action`, which the old hand-maintained copy was missing).
 */
function cspPlugin(apiOrigin: string): Plugin {
  return {
    name: 'cms:csp',
    transformIndexHtml(html, ctx) {
      if (ctx.server) {
        // The literal occurs exactly once in index.html; a plain replace is
        // safer than a regex across the CSP string's embedded quotes.
        return html.replace(`script-src 'self';`, `script-src 'self' 'unsafe-inline';`);
      }
      if (apiOrigin) {
        return html.replace(`connect-src 'self';`, `connect-src 'self' ${apiOrigin};`);
      }
      return html;
    },
    async closeBundle() {
      const distDir = fileURLToPath(new URL('./dist', import.meta.url));
      let html: string;
      try {
        html = await readFile(`${distDir}/index.html`, 'utf8');
      } catch {
        return; // No built index.html (e.g. unit-test builds).
      }
      const meta = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/.exec(
        html,
      );
      if (!meta) {
        throw new Error('cms:csp — no CSP meta tag found in dist/index.html');
      }
      // The built meta already carries the final connect-src (the
      // transformIndexHtml hook resolved the API origin), so the extracted
      // policy is used verbatim; regenerating the _headers copy from it
      // keeps the two sources from drifting.
      const csp = meta[1]!;
      const headersPath = `${distDir}/_headers`;
      let headers: string;
      try {
        headers = await readFile(headersPath, 'utf8');
      } catch {
        return; // No _headers in the output.
      }
      const replaced = headers.replace(
        /Content-Security-Policy: .*/,
        `Content-Security-Policy: ${csp}`,
      );
      await writeFile(headersPath, replaced, 'utf8');
    },
  };
}

/**
 * Vite configuration for the CMS frontend.
 *
 * The dev server proxies /api requests to the local Cloudflare
 * Worker (running on port 8787) so the frontend and backend can
 * be developed together without CORS configuration.
 *
 * The `test` block configures Vitest (unit tests). Tests run in a
 * jsdom environment so DOM APIs such as DOMParser are available —
 * the HTML scanner is tested against a realistic browser-like DOM.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  let apiOrigin = '';
  try {
    apiOrigin = env.VITE_API_BASE_URL ? new URL(env.VITE_API_BASE_URL).origin : '';
  } catch {
    apiOrigin = '';
  }

  return {
    plugins: [react(), cspPlugin(apiOrigin)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      // No sourcemaps in production builds: 'hidden' still emitted .map
      // files into dist/assets, which Workers Static Assets served — the
      // original TS source was recoverable from a deployed bundle.
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
