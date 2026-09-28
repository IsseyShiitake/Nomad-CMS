/**
 * Tests for the preview proxy route.
 *
 * Covers: session required, only https github.io targets accepted, the
 * upstream framing guards stripped, <base href> injection anchored at the
 * final URL, and the 404 path for unpublished/non-HTML sites. One
 * integration test goes through handleApiRequest to lock in that the
 * dispatcher does NOT stamp the shared X-Frame-Options: DENY onto the
 * preview response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { SessionManager } from '../services/auth';
import { handleApiRequest } from './index';
import type { RouteContext } from './index';
import { previewRoutes } from './preview';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';
const SITE_HTML = [
  '<!doctype html>',
  '<html>',
  '  <head>',
  '    <meta charset="utf-8">',
  '    <link rel="stylesheet" href="/style.css">',
  '  </head>',
  '  <body><h1>Site</h1></body>',
  '</html>',
].join('\n');

/** Minimal in-memory KVNamespace mock (put/get/delete/list). */
function mockKv() {
  const store = new Map<string, { value: string }>();
  const kv = {
    async put(key: string, value: string) {
      store.set(key, { value });
    },
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options: { prefix?: string }) {
      const keys = [...store.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(kv: KVNamespace): Env {
  return {
    SESSION_KV: kv,
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_REDIRECT_URI: 'http://localhost:5173/auth/callback',
    ASSETS: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) } as unknown as Fetcher,
    SESSION_ENCRYPTION_KEY: KEY,
    ALLOWED_ORIGINS: '',
    OPERATOR_LOGIN: '',
    CLOUDFLARE_OAUTH_CLIENT_ID: '',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: '',
    CLOUDFLARE_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/cloudflare/callback',
    VERCEL_OAUTH_CLIENT_ID: '',
    VERCEL_OAUTH_CLIENT_SECRET: '',
    VERCEL_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/vercel/callback',
  };
}

describe('preview route', () => {
  let ctx: RouteContext;
  let session: string;

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    session = await sessions.createSession('ghp_preview-token', {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function previewRequest(url: string | null, withCookie = true): Request {
    const query = url === null ? '' : `?url=${encodeURIComponent(url)}`;
    return new Request(`http://localhost/api/preview${query}`, {
      headers: withCookie ? { Cookie: `__Host-cms_session=${session}` } : {},
    });
  }

  /** Upstream site response carrying typical framing guards. */
  function upstreamResponse(body: string, status: number, contentType: string): Response {
    return new Response(body, {
      status,
      headers: {
        'Content-Type': contentType,
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  }

  it('requires a session', async () => {
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/', false),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it('rejects a missing url parameter', async () => {
    const response = await previewRoutes.handle('', previewRequest(null), ctx);
    expect(response.status).toBe(400);
  });

  it('rejects a malformed url parameter', async () => {
    const response = await previewRoutes.handle('', previewRequest('not a url'), ctx);
    expect(response.status).toBe(400);
  });

  it('rejects non-github.io hosts', async () => {
    const response = await previewRoutes.handle('', previewRequest('https://example.com/'), ctx);
    expect(response.status).toBe(403);
  });

  it('rejects plain-http targets', async () => {
    const response = await previewRoutes.handle(
      '',
      previewRequest('http://octocat.github.io/site/'),
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it('answers 404 when the upstream site is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse('not found', 404, 'text/html')));
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/'),
      ctx,
    );
    expect(response.status).toBe(404);
  });

  it('answers 404 when the upstream is not HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse('{}', 200, 'application/json')));
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/'),
      ctx,
    );
    expect(response.status).toBe(404);
  });

  it('serves the HTML with framing guards stripped and base injected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(SITE_HTML, 200, 'text/html')));
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/'),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=600');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    // The sandbox CSP (no allow-scripts) blocks script execution on this
    // origin even when the document is navigated to directly.
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');

    const body = await response.text();
    expect(body).toContain('<base href="https://octocat.github.io/site/">');
    expect(body.indexOf('<base href=')).toBeLessThan(body.indexOf('<link rel="stylesheet"'));
  });

  it('rejects a redirect that lands off the allowlisted hosts', async () => {
    // redirect:'follow' resolves to the FINAL url — a .github.io host that
    // bounces to an arbitrary origin must not be re-served from this Worker.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // ResponseInit has no url field; emulate redirect:'follow' by
        // constructing the redirected response the fetch would resolve to.
        const redirected = new Response('<html><body>evil</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(redirected, 'url', {
          value: 'https://evil.example.com/',
        });
        return redirected;
      }),
    );
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/'),
      ctx,
    );
    expect(response.status).toBe(404);
  });


  it('respects a base tag the site already ships', async () => {
    const withBase = SITE_HTML.replace('<head>', '<head><base href="https://cdn.example/">');
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(withBase, 200, 'text/html')));
    const response = await previewRoutes.handle(
      '',
      previewRequest('https://octocat.github.io/site/'),
      ctx,
    );
    const body = await response.text();
    expect(body.match(/<base /g)).toHaveLength(1);
  });

  it('keeps the response frameable through the real dispatcher', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(SITE_HTML, 200, 'text/html')));
    const response = await handleApiRequest(
      '/api/preview',
      previewRequest('https://octocat.github.io/site/'),
      ctx.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });
});
