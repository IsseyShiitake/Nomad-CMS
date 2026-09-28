/**
 * End-to-end smoke test: the full authenticated publish pipeline through the
 * real router (handleApiRequest) — connect platform (verify + store),
 * resolve links, publish with the repository default branch, read status —
 * with the Cloudflare/Vercel APIs mocked at the HTTP boundary only.
 *
 * This is the integration proof that the browser-facing API surface behaves
 * coherently for the frontend flows built on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../env';
import { SessionManager } from '../services/auth';
import { handleApiRequest } from './index';

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
    GITHUB_REDIRECT_URI: 'https://cms.example.com/auth/callback',
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

/** Cloudflare Pages project list body. */
const CF_PROJECTS = {
  success: true,
  result: [
    {
      id: 'p1',
      name: 'site',
      subdomain: 'site-abc',
      domains: ['site.example.com'],
      created_on: '2026-08-01T00:00:00Z',
      canonical_deployment: {
        id: 'd0',
        url: 'https://site.example.com',
        created_on: '2026-08-01T00:00:00Z',
        commit_message: 'initial',
        latest_stage: { name: 'deploy', status: 'success' },
        environment: 'production',
      },
      source: {
        type: 'github',
        config: { owner: 'octocat', repo_name: 'site', production_branch: 'main' },
      },
    },
  ],
};

describe('deploy pipeline end to end', () => {
  let env: Env;
  let adminSession: string;
  let clientSession: string;
  let fetchSpy: Mock;

  /** Performs an API request with the session cookie + CSRF header. */
  const call = (path: string, init: RequestInit = {}, session = adminSession): Promise<Response> =>
    handleApiRequest(
      path,
      new Request(`https://cms.example.com${path}`, {
        ...init,
        headers: {
          Cookie: `__Host-cms_session=${session}`,
          'X-CSRF-Token': 'x',
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
      env,
    );

  beforeEach(async () => {
    const { kv } = mockKv();
    env = makeEnv(kv);
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

  it('connects Cloudflare, resolves links, publishes, and reads status', async () => {
    // 1. Connect Cloudflare (verify + store).
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(CF_PROJECTS), { status: 200 }),
    );
    const connect = await call('/api/deploy/connections/cloudflare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'cf-secret', accountId: 'acc-1' }),
    });
    expect(connect.status).toBe(201);
    const connection = await data<{ platform: string; accountName: string | null }>(connect);
    expect(connection.platform).toBe('cloudflare');
    expect(JSON.stringify(connection)).not.toContain('cf-secret');

    // 2. Resolve the links for the repository.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(CF_PROJECTS), { status: 200 }),
    );
    const links = await call('/api/deploy/links/octocat/site');
    expect(links.status).toBe(200);
    const linkList = await data<
      Array<{ platform: string; projectName: string; url: string | null; latest: { state: string } | null }>
    >(links);
    expect(linkList).toEqual([
      expect.objectContaining({ platform: 'cloudflare', projectName: 'site' }),
    ]);

    // 3. Publish: project list → GitHub default branch → deployment POST.
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(CF_PROJECTS), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 1,
            name: 'site',
            full_name: 'octocat/site',
            default_branch: 'main',
            private: false,
            html_url: '',
            updated_at: '',
            owner: { login: 'octocat', avatar_url: null },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              id: 'dep-9',
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
    const publish = await call('/api/deploy/links/octocat/site/publish', { method: 'POST' });
    expect(publish.status).toBe(200);
    const outcome = await data<{ deployments: Array<{ platform: string; state: string }> }>(publish);
    expect(outcome.deployments).toEqual([
      { platform: 'cloudflare', projectName: 'site', deploymentId: 'dep-9', state: 'queued' },
    ]);

    // 4. Status: fresh project list reflects the deployment state.
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...CF_PROJECTS,
          result: [
            {
              ...CF_PROJECTS.result[0]!,
              canonical_deployment: {
                id: 'dep-9',
                url: 'https://site.example.com',
                created_on: '2026-08-05T00:00:00Z',
                commit_message: 'CMS: publish octocat/site',
                latest_stage: { name: 'deploy', status: 'active' },
                environment: 'production',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const status = await call('/api/deploy/links/octocat/site/status');
    expect(status.status).toBe(200);
    const statuses = await data<Array<{ platform: string; latest: { state: string; url: string | null } | null }>>(status);
    expect(statuses[0]!.latest).toEqual(
      expect.objectContaining({ state: 'building', url: 'https://site.example.com' }),
    );

    // 5. A client session can read its own status but not publish.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(CF_PROJECTS), { status: 200 }));
    const clientStatus = await call('/api/deploy/links/octocat/site/status', {}, clientSession);
    expect(clientStatus.status).toBe(200);

    fetchSpy.mockClear();
    const clientPublish = await call('/api/deploy/links/octocat/site/publish', { method: 'POST' }, clientSession);
    expect(clientPublish.status).toBe(403);
  });

  it('keeps GitHub flows intact when no platform is connected', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            path: 'index.html',
            name: 'index.html',
            type: 'file',
            size: 10,
            sha: 's1',
          },
        ]),
        { status: 200 },
      ),
    );
    const contents = await call('/api/repositories/octocat/site/contents');
    expect(contents.status).toBe(200);
    const files = await data<Array<{ path: string }>>(contents);
    expect(files[0]!.path).toBe('index.html');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      'https://api.github.com/repos/octocat/site/contents',
    );
  });
});
