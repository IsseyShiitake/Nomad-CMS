/**
 * Tests for the Vercel-direct repository fallback.
 *
 * Covers the virtual "vercel/<project>" namespace end to end through the
 * repository routes: listing direct projects as repositories, discovering
 * pages from the deployment file tree, reading page content, and saving a
 * page (upload + manifest deployment). Also verifies that GitHub owners
 * fall through to GitHub untouched and client sessions see nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../env';
import { SessionManager } from '../services/auth';
import { ConnectionStore } from '../services/deploy';
import { repositoryRoutes } from './repositories';
import type { RouteContext } from './index';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

/** Minimal in-memory KVNamespace mock. */
function mockKv() {
  const store = new Map<string, string>();
  const kv = {
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    get: async (key: string) => store.get(key) ?? null,
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(kv: KVNamespace): Env {
  return {
    SESSION_KV: kv,
    ASSETS: {} as Fetcher,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_REDIRECT_URI: 'http://localhost:5173/auth/callback',
    GITHUB_CLIENT_SECRET: 'secret',
    SESSION_ENCRYPTION_KEY: KEY,
    ALLOWED_ORIGINS: '',
    OPERATOR_LOGIN: '',
    CLOUDFLARE_OAUTH_CLIENT_ID: '',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: '',
    CLOUDFLARE_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/cloudflare/callback',
    VERCEL_OAUTH_CLIENT_ID: '',
    VERCEL_OAUTH_CLIENT_SECRET: '',
    VERCEL_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/vercel/callback',
  } as Env;
}

/** Unwraps the `{ data }` envelope. */
async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

/** A Vercel direct project body (no Git link). */
const DIRECT_PROJECT = {
  id: 'prj_1',
  name: 'site',
  createdAt: 1,
  updatedAt: 2,
  link: null,
  latestDeployments: [
    {
      id: 'dpl_1',
      url: 'site.vercel.app',
      readyState: 'READY',
      target: 'production',
      createdAt: 2,
    },
  ],
};

/** A flattened deployment file tree body. */
const TREE = [
  { name: 'index.html', type: 'file', uid: 'uid-1' },
  { name: 'about.html', type: 'file', uid: 'uid-2' },
  { name: 'hero.png', type: 'file', uid: 'uid-3' },
  { name: 'assets', type: 'directory', children: [{ name: 'style.css', type: 'file', uid: 'uid-4' }] },
];

describe('vercel-direct repository fallback', () => {
  let ctx: RouteContext;
  let adminSession: string;
  let clientSession: string;
  let fetchSpy: Mock;

  /** Connects Vercel for the admin so the virtual namespace resolves. */
  const connectVercel = async (kv: KVNamespace): Promise<void> => {
    const connections = new ConnectionStore(kv, KEY);
    await connections.put({
      platform: 'vercel',
      owner: 'octocat',
      token: 'v-secret',
      accountId: null,
      accountName: 'Octo',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });
  };

  beforeEach(async () => {
    const { kv } = mockKv();
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession('ghp_admin', {
      id: 1,
      login: 'octocat',
      name: 'Octocat',
      avatarUrl: null,
    });
    clientSession = await sessions.createClientSession(
      'ghp_client',
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
    );
    await connectVercel(kv);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function request(path: string, session: string, init: RequestInit = {}): Request {
    return new Request(`http://localhost/api/repositories${path}`, {
      ...init,
      headers: {
        Cookie: `__Host-cms_session=${session}`,
        'X-CSRF-Token': 'x',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  it('lists direct projects as virtual repositories for admins', async () => {
    fetchSpy
      // GitHub repository list (the repo list always starts with GitHub).
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      // Vercel project list.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [DIRECT_PROJECT], pagination: {} }), {
          status: 200,
        }),
      );

    const response = await repositoryRoutes.handle('/', request('/', adminSession), ctx);
    const repositories = await data<Array<{ owner: string; name: string; fullName: string }>>(response);

    expect(repositories).toEqual([
      expect.objectContaining({
        owner: 'vercel',
        name: 'site',
        fullName: 'vercel/site',
        homepage: 'https://site.vercel.app',
      }),
    ]);
  });

  it('serves page discovery from the deployment file tree', async () => {
    fetchSpy
      // getProject
      .mockResolvedValueOnce(
        new Response(JSON.stringify(DIRECT_PROJECT), { status: 200 }),
      )
      // deployment files
      .mockResolvedValueOnce(new Response(JSON.stringify(TREE), { status: 200 }));

    const response = await repositoryRoutes.handle(
      '/vercel/site/pages',
      request('/vercel/site/pages', adminSession),
      ctx,
    );
    const pages = await data<Array<{ path: string }>>(response);
    expect(pages).toEqual([{ path: 'index.html' }, { path: 'about.html' }]);
  });

  it('serves page content from the deployment', async () => {
    fetchSpy
      // getProject
      .mockResolvedValueOnce(new Response(JSON.stringify(DIRECT_PROJECT), { status: 200 }))
      // deployment files (uid lookup)
      .mockResolvedValueOnce(new Response(JSON.stringify(TREE), { status: 200 }))
      // file content (raw bytes)
      .mockResolvedValueOnce(
        new Response('<html><body><h1>Hi</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

    const response = await repositoryRoutes.handle(
      '/vercel/site/pages/index.html',
      request('/vercel/site/pages/index.html', adminSession),
      ctx,
    );
    const page = await data<{ path: string; content: string; sha: string | null }>(response);
    expect(page.path).toBe('index.html');
    expect(page.content).toContain('<h1>Hi</h1>');
    expect(page.sha).toBeNull();
  });

  it('saves a page by uploading and re-deploying with a full manifest', async () => {
    fetchSpy
      // getProject
      .mockResolvedValueOnce(new Response(JSON.stringify(DIRECT_PROJECT), { status: 200 }))
      // file upload (POST /v2/files) — 200 empty
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      // manifest tree (the save flow lists current files)
      .mockResolvedValueOnce(new Response(JSON.stringify(TREE), { status: 200 }))
      // deployment create
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'dpl_2',
            url: 'site-2.vercel.app',
            readyState: 'INITIALIZING',
            target: 'production',
            createdAt: 3,
          }),
          { status: 200 },
        ),
      );

    const response = await repositoryRoutes.handle(
      '/vercel/site/pages/index.html',
      request('/vercel/site/pages/index.html', adminSession, {
        method: 'PUT',
        body: JSON.stringify({ content: '<html><body><h1>New</h1></body></html>' }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const result = await data<{ success: boolean; sha: string | null }>(response);
    expect(result.success).toBe(true);

    // The deployment create must carry a manifest containing every file,
    // with the saved page referenced by digest.
    const deployBody = JSON.parse(
      fetchSpy.mock.calls[3]![1].body as string,
    ) as { name: string; target: string; files: Array<{ file: string; sha?: string }> };
    expect(deployBody.name).toBe('site');
    expect(deployBody.target).toBe('production');
    expect(deployBody.files.map((f) => f.file)).toEqual(
      expect.arrayContaining(['index.html', 'about.html', 'hero.png', 'assets/style.css']),
    );
    const saved = deployBody.files.find((f) => f.file === 'index.html');
    expect(saved?.sha).toBeTruthy();
  });

  it('rejects client sessions on the virtual namespace via the repo lock', async () => {
    const response = await repositoryRoutes.handle(
      '/vercel/site/pages',
      request('/vercel/site/pages', clientSession),
      ctx,
    );
    // The client is locked to octocat/site; the lock fires for the virtual
    // namespace exactly as for any other repository — before any backend is
    // consulted.
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still serves GitHub owners through the GitHub client', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 1,
          name: 'site',
          full_name: 'octocat/site',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/octocat/site',
          updated_at: '2026-08-01T00:00:00Z',
          owner: { login: 'octocat', avatar_url: null },
        }),
        { status: 200 },
      ),
    );

    const response = await repositoryRoutes.handle(
      '/octocat/site',
      request('/octocat/site', adminSession),
      ctx,
    );
    const repository = await data<{ fullName: string }>(response);
    expect(repository.fullName).toBe('octocat/site');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('https://api.github.com/repos/octocat/site');
  });

  it('answers 404 when the project is a Git-connected Vercel project', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...DIRECT_PROJECT,
          link: { type: 'github', org: 'octocat', repo: 'site' },
        }),
        { status: 200 },
      ),
    );

    const response = await repositoryRoutes.handle(
      '/vercel/site/pages',
      request('/vercel/site/pages', adminSession),
      ctx,
    );
    expect(response.status).toBe(404);
  });

  it('maps a Vercel-direct outage to a 502 deploy_error, never a 500', async () => {
    // resolveDirect performs a live Vercel getProject; any failure there
    // must surface as a mapped error envelope, not an unhandled exception.
    fetchSpy.mockRejectedValue(new Error('boom'));

    const response = await repositoryRoutes.handle(
      '/vercel/site/pages',
      request('/vercel/site/pages', adminSession),
      ctx,
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('deploy_error');
  });
});
