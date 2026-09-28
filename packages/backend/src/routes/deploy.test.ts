/**
 * Tests for the /api/deploy routes.
 *
 * Covers the connection lifecycle (connect-then-verify, secrets stripped,
 * admin-only), link resolution from platform project metadata, publish
 * triggering with the repository's real default branch, and client-session
 * restrictions (read links, never publish).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../env';
import { SessionManager } from '../services/auth';
import { deployRoutes } from './deploy';
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

/** Cloudflare project list response body. */
const CF_BODY = JSON.stringify({
  success: true,
  result: [
    {
      id: 'p1',
      name: 'site',
      subdomain: 'site-abc',
      domains: [],
      created_on: '2026-08-01T00:00:00Z',
      canonical_deployment: null,
      source: {
        type: 'github',
        config: { owner: 'octocat', repo_name: 'site', production_branch: 'main' },
      },
    },
  ],
});

/** GitHub repository metadata for the default-branch lookup. */
const GITHUB_REPO_BODY = JSON.stringify({
  id: 1,
  name: 'site',
  full_name: 'octocat/site',
  default_branch: 'production',
  private: false,
  html_url: 'https://github.com/octocat/site',
  updated_at: '2026-08-01T00:00:00Z',
  owner: { login: 'octocat', avatar_url: null },
});

describe('deploy routes', () => {
  let ctx: RouteContext;
  let adminSession: string;
  let clientSession: string;
  let fetchSpy: Mock;

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
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function request(path: string, session: string, init: RequestInit = {}): Request {
    return new Request(`http://localhost/api/deploy${path}`, {
      ...init,
      headers: {
        Cookie: `__Host-cms_session=${session}`,
        'X-CSRF-Token': 'x',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  it('rejects unauthenticated requests', async () => {
    const response = await deployRoutes.handle(
      '/connections',
      new Request('http://localhost/api/deploy/connections'),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it('rejects client sessions from connection management', async () => {
    const response = await deployRoutes.handle('/connections', request('/connections', clientSession), ctx);
    expect(response.status).toBe(403);
  });

  it('connect verifies the token before storing and never returns it', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));

    const response = await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );
    const connection = await data<{ platform: string; accountId: string; accountName: string | null }>(response);
    const raw = JSON.stringify(connection);
    expect(connection.platform).toBe('cloudflare');
    expect(connection.accountId).toBe('acc-1');
    expect(raw).not.toContain('cf-secret');
  });

  it('requires an account id for Cloudflare connects', async () => {
    const response = await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret' }),
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to store a token the platform rejects', async () => {
    fetchSpy.mockResolvedValue(new Response('bad token', { status: 401 }));

    const response = await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'bad-token', accountId: 'acc-1' }),
      }),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('x-cms-platform-token-invalid')).toBe('1');
  });

  it('lists connections without tokens', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );

    const response = await deployRoutes.handle('/connections', request('/connections', adminSession), ctx);
    const connections = await data<Array<{ platform: string }>>(response);
    expect(connections).toEqual([expect.objectContaining({ platform: 'cloudflare' })]);
    expect(JSON.stringify(connections)).not.toContain('cf-secret');
  });

  it('resolves links from platform project metadata', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));

    const response = await deployRoutes.handle(
      '/links/octocat/site',
      request('/links/octocat/site', adminSession),
      ctx,
    );

    expect(response.status).toBe(200);
    const links = await data<Array<{ platform: string; projectName: string; mode: string; url: string | null; latest: unknown }>>(response);
    expect(links).toEqual([
      { platform: 'cloudflare', projectName: 'site', mode: 'git', url: 'https://site-abc.pages.dev', latest: null },
    ]);
  });

  it('resolves client-session links through the creating admin (connectionOwner)', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    // Connect cloudflare as the admin (verify probe + store).
    const connect = await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );
    expect(connect.status).toBe(201);
    // Response bodies are single-use; re-arm the mock for the link lookup.
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));

    // A client session carrying the admin's login (createdBy) reads links
    // for its locked repo through that admin's connections.
    const sessions = new SessionManager(ctx.env.SESSION_KV, KEY);
    const ownedClientSession = await sessions.createClientSession(
      'ghp_client',
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
      'octocat',
    );
    const response = await deployRoutes.handle(
      '/links/octocat/site',
      request('/links/octocat/site', ownedClientSession),
      ctx,
    );
    expect(response.status).toBe(200);
    const links = await data<Array<{ platform: string }>>(response);
    expect(links).toHaveLength(1);
    expect(links[0]!.platform).toBe('cloudflare');
  });

  it('returns an empty link list when nothing matches the repo', async () => {
    // Connect (any successful body), then serve a project list whose repo
    // does not match the queried one.
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: 'p9',
              name: 'other',
              subdomain: null,
              domains: [],
              created_on: '2026-08-01T00:00:00Z',
              canonical_deployment: null,
              source: { type: 'github', config: { owner: 'someone', repo_name: 'else' } },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const response = await deployRoutes.handle(
      '/links/octocat/site',
      request('/links/octocat/site', adminSession),
      ctx,
    );
    const links = await data<unknown[]>(response);
    expect(links).toEqual([]);
  });

  it('publishes through the repository default branch', async () => {
    // Connect.
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );
    // Publish: link resolution (projects list), GitHub default-branch
    // lookup, then the deploy POST.
    fetchSpy
      .mockResolvedValueOnce(new Response(CF_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(GITHUB_REPO_BODY, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              id: 'dep-1',
              url: null,
              created_on: '2026-08-05T00:00:00Z',
              commit_message: null,
              latest_stage: { name: 'queued', status: 'active' },
              environment: 'production',
            },
          }),
          { status: 200 },
        ),
      );

    const response = await deployRoutes.handle(
      '/links/octocat/site/publish',
      request('/links/octocat/site/publish', adminSession, { method: 'POST' }),
      ctx,
    );

    expect(response.status).toBe(200);
    const result = await data<{ deployments: Array<{ platform: string; deploymentId: string; state: string }> }>(response);
    expect(result.deployments).toEqual([
      { platform: 'cloudflare', projectName: 'site', deploymentId: 'dep-1', state: 'queued' },
    ]);
  });

  it('publishes via Vercel with the repo default branch from GitHub', async () => {
    // Connect: verify() resolves the account name via /v2/user (no team id).
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ user: { username: 'octocat', name: 'Octo Cat' } }),
        { status: 200 },
      ),
    );
    await deployRoutes.handle(
      '/connections/vercel',
      request('/connections/vercel', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'v-secret' }),
      }),
      ctx,
    );

    fetchSpy
      // link resolution (project list)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projects: [
              {
                id: 'prj_1',
                name: 'site',
                createdAt: 1,
                updatedAt: 1,
                link: { type: 'github', org: 'octocat', repo: 'site', productionBranch: 'main' },
                latestDeployments: [],
              },
            ],
            pagination: {},
          }),
          { status: 200 },
        ),
      )
      // GitHub default-branch lookup
      .mockResolvedValueOnce(new Response(GITHUB_REPO_BODY, { status: 200 }))
      // Vercel deployment create
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'dpl_9',
            url: 'site.vercel.app',
            readyState: 'QUEUED',
            target: 'production',
            createdAt: 1,
          }),
          { status: 200 },
        ),
      );

    const response = await deployRoutes.handle(
      '/links/octocat/site/publish',
      request('/links/octocat/site/publish', adminSession, { method: 'POST' }),
      ctx,
    );

    expect(response.status).toBe(200);
    // The Vercel deploy call must carry the real default branch ("production").
    const deployBody = JSON.parse(
      fetchSpy.mock.calls[3]![1].body as string,
    ) as { gitSource: { ref: string } };
    expect(deployBody.gitSource.ref).toBe('production');
    const result = await data<{ deployments: Array<{ platform: string; state: string }> }>(response);
    expect(result.deployments[0]).toMatchObject({ platform: 'vercel', state: 'queued' });
  });

  it('client sessions can read links but never publish', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    // Admin connects.
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );

    // Client reads links of its locked repo → legacy client sessions
    // (no connectionOwner) short-circuit to an empty list.
    const links = await deployRoutes.handle(
      '/links/octocat/site',
      request('/links/octocat/site', clientSession),
      ctx,
    );
    expect(links.status).toBe(200);

    // Client attempts publish → 403.
    const publish = await deployRoutes.handle(
      '/links/octocat/site/publish',
      request('/links/octocat/site/publish', clientSession, { method: 'POST' }),
      ctx,
    );
    expect(publish.status).toBe(403);
  });

  it('enforces the repository lock on link reads for client sessions', async () => {
    const response = await deployRoutes.handle(
      '/links/octocat/other',
      request('/links/octocat/other', clientSession),
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it('returns 404 when publishing an unlinked repository', async () => {
    const response = await deployRoutes.handle(
      '/links/octocat/site/publish',
      request('/links/octocat/site/publish', adminSession, { method: 'POST' }),
      ctx,
    );
    expect(response.status).toBe(404);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('no_linked_project');
  });

  it('disconnects a platform', async () => {
    fetchSpy.mockResolvedValue(new Response(CF_BODY, { status: 200 }));
    await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
      }),
      ctx,
    );

    const response = await deployRoutes.handle(
      '/connections/cloudflare',
      request('/connections/cloudflare', adminSession, { method: 'DELETE' }),
      ctx,
    );
    expect(response.status).toBe(200);

    const list = await deployRoutes.handle('/connections', request('/connections', adminSession), ctx);
    const connections = await data<unknown[]>(list);
    expect(connections).toEqual([]);
  });
});
