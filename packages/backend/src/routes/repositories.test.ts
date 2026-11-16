/**
 * Tests for the repository contents route.
 *
 * Covers the root listing regression: GET /:owner/:repo/contents (no path)
 * must match the contents branch and return 200, not fall through to the
 * 404 "Repository route not found" branch. Also covers nested paths and
 * unauthenticated requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { ClientStore, SessionManager } from '../services/auth';
import { repositoryRoutes } from './repositories';
import { handleApiRequest } from './index';
import type { RouteContext } from './index';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';
const ADMIN_TOKEN = 'ghp_admin-github-token';

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

/** Unwraps the `{ data: ... }` envelope used by every route. */
async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

/** Unwraps the `{ error: ... }` envelope used by API failures. */
async function errorBody(
  response: Response,
): Promise<{ error?: { code: string; message: string } }> {
  return (await response.json()) as { error?: { code: string; message: string } };
}

describe('repository contents route', () => {
  let ctx: RouteContext;
  let adminSession: string;

  const GITHUB_ENTRIES = [
    {
      path: 'docs',
      name: 'docs',
      type: 'dir',
      size: 0,
      sha: 'dir-sha',
    },
    {
      path: 'index.html',
      name: 'index.html',
      type: 'file',
      size: 512,
      sha: 'file-sha',
    },
  ];

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(GITHUB_ENTRIES), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the repository root at /:owner/:repo/contents', async () => {
    const fetchSpy = vi.mocked(fetch);

    const response = await repositoryRoutes.handle(
      '/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toContain(
      'https://api.github.com/repos/octocat/site/contents',
    );
    const files = await data<Array<{ path: string; name: string; type: string; size: number; sha: string }>>(response);
    expect(files).toEqual([
      { path: 'docs', name: 'docs', type: 'dir', size: 0, sha: 'dir-sha' },
      { path: 'index.html', name: 'index.html', type: 'file', size: 512, sha: 'file-sha' },
    ]);
  });

  it('still lists nested paths at /:owner/:repo/contents/:path', async () => {
    const fetchSpy = vi.mocked(fetch);

    const response = await repositoryRoutes.handle(
      '/octocat/site/contents/docs',
      new Request('http://localhost/api/repositories/octocat/site/contents/docs', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[0]![0]).toContain(
      'https://api.github.com/repos/octocat/site/contents/docs',
    );
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await repositoryRoutes.handle(
      '/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents'),
      ctx,
    );
    expect(response.status).toBe(401);
  });
});

describe('raw asset proxy route', () => {
  let ctx: RouteContext;
  let adminSession: string;
  let clientSession: string;

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    clientSession = await sessions.createClientSession(
      'ghp_client-github-token',
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeRequest(path: string, session?: string): Request {
    return new Request(`http://localhost/api/repositories${path}`, {
      headers: session ? { Cookie: `__Host-cms_session=${session}` } : undefined,
    });
  }

  it('serves a css asset with a text/css content type', async () => {
    const cssBytes = new TextEncoder().encode('body { color: red; }');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(cssBytes, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );

    const response = await repositoryRoutes.handle(
      '/octocat/site/raw/style.css',
      makeRequest('/octocat/site/raw/style.css', adminSession),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css');
    expect(await response.text()).toBe('body { color: red; }');
    // The asset fetch goes straight to raw.githubusercontent.com via the
    // fixed HEAD ref (no prior repository-metadata request).
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain(
      'https://raw.githubusercontent.com/octocat/site/HEAD/style.css',
    );
  });


  it('rejects encoded traversal paths with 404', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const response = await repositoryRoutes.handle(
      '/octocat/site/raw/..%2Fwrangler.toml',
      makeRequest('/octocat/site/raw/..%2Fwrangler.toml', adminSession),
      ctx,
    );

    expect(response.status).toBe(404);
  });

  it('rejects unauthenticated requests with 401', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const response = await repositoryRoutes.handle(
      '/octocat/site/raw/style.css',
      makeRequest('/octocat/site/raw/style.css'),
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it('rejects client sessions locked to another repository with 403', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const response = await repositoryRoutes.handle(
      '/octocat/other/raw/style.css',
      makeRequest('/octocat/other/raw/style.css', clientSession),
      ctx,
    );

    expect(response.status).toBe(403);
  });

  it('locks the page-read route too (GET /:owner/:repo/pages/:path)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const response = await repositoryRoutes.handle(
      '/octocat/other/pages/index.html',
      makeRequest('/octocat/other/pages/index.html', clientSession),
      ctx,
    );

    // Regression pin: this route computed the lock but never returned it —
    // a client could read any repository's HTML.
    expect(response.status).toBe(403);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('session purge middleware', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let adminSession: string;
  let deletedKeys: string[];

  beforeEach(async () => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
    deletedKeys = [];
    const originalDelete = kv.delete.bind(kv);
    (kv as unknown as { delete: (key: string) => Promise<void> }).delete = async (key: string) => {
      deletedKeys.push(key);
      await originalDelete(key);
    };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('purges the session when GitHub reports the token invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad credentials', { status: 401 })),
    );

    const response = await handleApiRequest(
      '/api/repositories/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx.env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('x-cms-github-token-invalid')).toBe('1');
    // The dead session is gone so the next /session returns null.
    expect(deletedKeys.length).toBeGreaterThan(0);
    const sessions = new SessionManager(kv, KEY);
    expect(await sessions.getSession(adminSession)).toBeNull();
  });

  it('keeps client sessions alive when the backing GitHub token is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad credentials', { status: 401 })),
    );

    const sessions = new SessionManager(kv, KEY);
    const clientSession = await sessions.createClientSession(
      ADMIN_TOKEN,
      { id: 0, login: 'ACME', name: 'ACME', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
    );

    const response = await handleApiRequest(
      '/api/repositories/octocat/site/pages',
      new Request('http://localhost/api/repositories/octocat/site/pages', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx.env,
    );

    expect(response.status).toBe(403);
    expect((await errorBody(response)).error?.code).toBe('backing_token_invalid');
    // No marker and no KV delete: the client's own login survives so the UI
    // can explain the problem instead of bouncing to the sign-in screen.
    expect(response.headers.get('x-cms-github-token-invalid')).toBeNull();
    expect(deletedKeys).toHaveLength(0);
    expect(await sessions.getSession(clientSession)).not.toBeNull();
  });

  it('does not purge on unauthenticated 401s', async () => {
    const response = await handleApiRequest(
      '/api/repositories/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents'),
      ctx.env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('x-cms-github-token-invalid')).toBeNull();
    expect(deletedKeys).toHaveLength(0);
  });

  it('returns 401 (not 500) for a malformed session cookie', async () => {
    const response = await handleApiRequest(
      '/api/repositories/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents', {
        headers: { Cookie: '__Host-cms_session=%ZZ' },
      }),
      ctx.env,
    );

    expect(response.status).toBe(401);
    expect(deletedKeys).toHaveLength(0);
  });
});

describe('path decoding and method guards', () => {
  let ctx: RouteContext;
  let adminSession: string;

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a clean 4xx (not 500) for a malformed percent escape in the path', async () => {
    // The escape fails to decode; the charset guard then rejects the raw
    // segment with 400 — never an unhandled URIError 500.
    const response = await handleApiRequest(
      '/api/repositories/octocat/%E0%A4/contents',
      new Request('http://localhost/api/repositories/octocat/%E0%A4/contents', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx.env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects non-GET methods on read routes with 405', async () => {
    const response = await repositoryRoutes.handle(
      '/octocat/site/contents',
      new Request('http://localhost/api/repositories/octocat/site/contents', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'x' },
      }),
      ctx,
    );
    expect(response.status).toBe(405);
  });

  it('rejects owner/repo names outside the GitHub charset with 400', async () => {
    const response = await repositoryRoutes.handle(
      '/octocat%3F/site/contents',
      new Request('http://localhost/api/repositories/octocat%3F/site/contents', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects an oversized page save with 413 before any GitHub call', async () => {
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
    const declared = await repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        method: 'PUT',
        headers: {
          Cookie: `__Host-cms_session=${adminSession}`,
          'X-CSRF-Token': 'x',
          'Content-Length': String(huge.length + 64),
        },
        body: JSON.stringify({ content: huge }),
      }),
      ctx,
    );
    expect(declared.status).toBe(413);

    const actual = await repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        method: 'PUT',
        headers: {
          Cookie: `__Host-cms_session=${adminSession}`,
          'X-CSRF-Token': 'x',
        },
        body: JSON.stringify({ content: huge }),
      }),
      ctx,
    );
    expect(actual.status).toBe(413);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods on the root listing with 405', async () => {
    const response = await repositoryRoutes.handle(
      '/',
      new Request('http://localhost/api/repositories/', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'x' },
      }),
      ctx,
    );
    expect(response.status).toBe(405);
  });
});

describe('repository listing hasHtml annotation', () => {
  let ctx: RouteContext;
  let adminSession: string;

  /** Shared GitHub repo fields for listing fixtures. */
  const REPO_BASE = {
    owner: { login: 'octocat', avatar_url: null },
    default_branch: 'main',
    description: null,
    private: false,
    homepage: null,
    html_url: 'https://github.com/octocat/repo',
    updated_at: '2026-09-01T00:00:00Z',
  };

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags each repository: html found / empty repository / check failure stays unknown', async () => {
    const fetchSpy = vi.fn();
    fetchSpy
      // Repository listing (single short page ends the pagination loop).
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 1, name: 'with-html', full_name: 'octocat/with-html', ...REPO_BASE },
            { id: 2, name: 'no-html', full_name: 'octocat/no-html', ...REPO_BASE },
            { id: 3, name: 'broken', full_name: 'octocat/broken', ...REPO_BASE },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Tree probes in listing order (the pool starts one worker per repo
      // and each issues its fetch synchronously before awaiting).
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tree: [{ path: 'index.html', type: 'blob', sha: 'sha', size: 10 }],
            truncated: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Empty repository → GitHub 409 → hasHtml false.
      .mockResolvedValueOnce(new Response('{"message":"Git Repository is empty."}', { status: 409 }))
      // Probe failure → hasHtml null (repo stays listed).
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const response = await repositoryRoutes.handle(
      '/',
      new Request('http://localhost/api/repositories', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const repos = await data<Array<{ fullName: string; hasHtml: boolean | null }>>(response);
    expect(repos.map((repo) => [repo.fullName, repo.hasHtml])).toEqual([
      ['octocat/with-html', true],
      ['octocat/no-html', false],
      ['octocat/broken', null],
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

describe('revoked and deleted client sessions (audit 2026-11-15 must-fix)', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let clientSession: string;

  beforeEach(async () => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    const store = new ClientStore(kv, KEY);
    await store.create({
      clientId: 'acme-corp',
      label: 'ACME Corp',
      repo: { owner: 'octocat', repo: 'site' },
      createdBy: 'octocat',
      passwordHash: 'hash',
      salt: 'salt',
      githubToken: await store.encryptGitHubToken(ADMIN_TOKEN),
      createdAt: '2026-11-15T00:00:00Z',
      lastUsedAt: null,
      revoked: false,
      failedAttempts: 0,
      lockedUntil: null,
    });
    clientSession = await sessions.createClientSession(
      ADMIN_TOKEN,
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
      'octocat',
      null,
      'acme-corp',
    );
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pageRequest(): Request {
    return new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
      headers: { Cookie: `__Host-cms_session=${clientSession}` },
    });
  }

  it('rejects a revoked client access with 401 while the session cookie is still live', async () => {
    const before = await repositoryRoutes.handle('/octocat/site/pages/index.html', pageRequest(), ctx);
    expect(before.status).not.toBe(401); // the live access works

    const store = new ClientStore(kv, KEY);
    await store.update('acme-corp', { revoked: true });
    vi.mocked(fetch).mockClear();

    // Same untouched cookie, now revoked: 401 on every repository route.
    const after = await repositoryRoutes.handle('/octocat/site/pages/index.html', pageRequest(), ctx);
    expect(after.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects a deleted client access with 401 while the session cookie is still live', async () => {
    const store = new ClientStore(kv, KEY);
    await store.delete('acme-corp');

    const response = await repositoryRoutes.handle('/octocat/site/pages/index.html', pageRequest(), ctx);
    expect(response.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('a revoked approval-mode access can no longer save (no direct-to-main fallback)', async () => {
    const store = new ClientStore(kv, KEY);
    await store.update('acme-corp', { revoked: true, requireApproval: true });

    const response = await repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        method: 'PUT',
        headers: {
          Cookie: `__Host-cms_session=${clientSession}`,
          'X-CSRF-Token': 'test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '<h1>Edited</h1>', sha: 'file-sha' }),
      }),
      ctx,
    );
    // 401 beats everything: the revoked session never reaches a write path.
    expect(response.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('server-side placeholder guard (audit 2026-11-15)', () => {
  let ctx: RouteContext;
  let adminSession: string;

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: { path: 'index.html', sha: 'new-sha', size: 10, name: 'index.html' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function putContent(content: string): Promise<Response> {
    return repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        method: 'PUT',
        headers: {
          Cookie: `__Host-cms_session=${adminSession}`,
          'X-CSRF-Token': 'x',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, sha: 'file-sha' }),
      }),
      ctx,
    );
  }

  it('rejects a save still carrying the placeholder image src (double-quoted)', async () => {
    const response = await putContent('<p>Hi</p><img src="/images/placeholder.png" alt="">');
    expect(response.status).toBe(422);
    expect((await errorBody(response)).error?.code).toBe('placeholder_image');
  });

  it('rejects the single-quoted attribute form too', async () => {
    const response = await putContent("<img src='/images/placeholder.png' alt=''>");
    expect(response.status).toBe(422);
    expect((await errorBody(response)).error?.code).toBe('placeholder_image');
  });

  it('rejects a save still carrying untouched insert text', async () => {
    const response = await putContent('<h1>Hi</h1><p>New p</p>');
    expect(response.status).toBe(422);
    expect((await errorBody(response)).error?.code).toBe('placeholder_text');
  });

  it('allows normal content through to the commit', async () => {
    const response = await putContent('<h1>Hi</h1><p>Mentions New p in prose? No — plain copy.</p>');
    // prose mentions are fine: only the exact serialized form is rejected.
    expect(response.status).toBe(200);
  });
});

describe('image upload tree lookup error narrowing (audit 2026-11-15)', () => {
  it('surfaces a GitHub 5xx from the existingSha tree lookup instead of degrading to a create-PUT', async () => {
    const { kv } = mockKv();
    const ctx: RouteContext = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    const adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push(`${method} ${url}`);
        if (url.includes('/git/trees/')) {
          return new Response('{"message":"boom"}', { status: 500 });
        }
        return new Response('{"message":"unmocked"}', { status: 500 });
      }),
    );

    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG-ish bytes
    const response = await repositoryRoutes.handle(
      '/octocat/site/images',
      new Request('http://localhost/api/repositories/octocat/site/images', {
        method: 'POST',
        headers: {
          Cookie: `__Host-cms_session=${adminSession}`,
          'X-CSRF-Token': 'x',
          'Content-Type': 'multipart/form-data; boundary=x',
        },
        body: formDataWithPng(bytes),
      }),
      ctx,
    );

    // The tree failure surfaced as 502 and NO contents-PUT was attempted.
    expect(response.status).toBe(502);
    expect(calls.some((call) => call.startsWith('PUT '))).toBe(false);
    vi.unstubAllGlobals();
  });
});

/** Builds a minimal multipart body carrying one PNG file field. */
function formDataWithPng(bytes: Uint8Array): string {
  const boundary = 'x';
  return (
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="pic.png"\r\n' +
    'Content-Type: image/png\r\n' +
    '\r\n' +
    Buffer.from(bytes).toString('latin1') +
    `\r\n--${boundary}--\r\n`
  );
}

describe('session purge on every route family (audit 2026-11-15)', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let adminSession: string;
  let deletedKeys: string[];

  beforeEach(async () => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
    deletedKeys = [];
    const originalDelete = kv.delete.bind(kv);
    (kv as unknown as { delete: (key: string) => Promise<void> }).delete = async (key: string) => {
      deletedKeys.push(key);
      await originalDelete(key);
    };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession('ghp_dead-admin-token', {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    // The review queue enumerates client accesses' repositories; a record
    // makes the route actually call GitHub (which answers 401 below).
    const store = new ClientStore(kv, KEY);
    await store.create({
      clientId: 'acme-corp',
      label: 'ACME Corp',
      repo: { owner: 'octocat', repo: 'site' },
      createdBy: 'octocat',
      passwordHash: 'hash',
      salt: 'salt',
      githubToken: await store.encryptGitHubToken('ghp_dead-admin-token'),
      createdAt: '2026-11-15T00:00:00Z',
      lastUsedAt: null,
      revoked: false,
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('purges the session when a review route reports the token invalid', async () => {
    // The queue listing swallows per-repo failures (one dead repo must not
    // hide the rest), so exercise the merge action, which maps the upstream
    // 401 to the marker-carrying response.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad credentials', { status: 401 })),
    );

    const response = await handleApiRequest(
      '/api/review/octocat/site/7/merge',
      new Request('http://localhost/api/review/octocat/site/7/merge', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'x' },
      }),
      ctx.env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('x-cms-github-token-invalid')).toBe('1');
    expect(deletedKeys.length).toBeGreaterThan(0);
    const sessions = new SessionManager(kv, KEY);
    expect(await sessions.getSession(adminSession)).toBeNull();
  });
});
