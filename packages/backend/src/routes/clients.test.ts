/**
 * Tests for the client access routes and the repository lock.
 *
 * Covers: create returns a one-time password and stores only a hash; list
 * strips secrets; revoke sets revoked; non-admin sessions get 403; the
 * client-login flow (success, wrong password, lockout, revoked); and the
 * repo lock rejecting other repositories with 403.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { ClientStore, SessionManager } from '../services/auth';
import { authRoutes } from './auth';
import { clientsRoutes } from './clients';
import { repositoryRoutes } from './repositories';
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
    ASSETS: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) } as unknown as Fetcher,
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_REDIRECT_URI: 'http://localhost:5173/auth/callback',
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

function makeRequest(
  method: string,
  sessionToken: string | null,
  body?: unknown,
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionToken) headers.Cookie = `__Host-cms_session=${sessionToken}`;
  return new Request('http://localhost/api/clients', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Unwraps the `{ data: ... }` envelope used by every route. */
async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

describe('clients routes', () => {
  let kv: KVNamespace;
  let store: Map<string, { value: string }>;
  let ctx: RouteContext;
  let adminSession: string;

  beforeEach(async () => {
    ({ kv, store } = mockKv());
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: null,
      avatarUrl: null,
    });
  });

  it('rejects unauthenticated and non-admin sessions', async () => {
    const anonymous = await clientsRoutes.handle('/', makeRequest('GET', null), ctx);
    expect(anonymous.status).toBe(401);

    const sessions = new SessionManager(kv, KEY);
    const clientSession = await sessions.createClientSession(
      ADMIN_TOKEN,
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
    );
    const forbidden = await clientsRoutes.handle('/', makeRequest('GET', clientSession), ctx);
    expect(forbidden.status).toBe(403);
  });

  it('creates an access with a one-time password and stores only a hash', async () => {
    const response = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'ACME Corp',
      }),
      ctx,
    );
    expect(response.status).toBe(201);

    const created = await data<{ access: { clientId: string }; password: string }>(response);
    expect(created.password).toHaveLength(14);
    expect(created.access.clientId).toMatch(/^acme-corp-[a-z0-9]{4}$/);

    // The stored record holds a hash, never the plaintext password, and an
    // encrypted (not plaintext) GitHub token.
    const raw = store.get(`client:${created.access.clientId}`)!.value;
    expect(raw.includes(created.password)).toBe(false);
    expect(raw.includes(ADMIN_TOKEN)).toBe(false);
    const record = JSON.parse(raw) as { passwordHash: string; githubToken: string };
    expect(record.passwordHash).not.toBe(created.password);
    expect(record.githubToken.length).toBeGreaterThan(0);
  });

  it('validates the create payload', async () => {
    const missing = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, { repoOwner: 'octocat', repoName: 'site' }),
      ctx,
    );
    expect(missing.status).toBe(400);

    const longLabel = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'x'.repeat(61),
      }),
      ctx,
    );
    expect(longLabel.status).toBe(400);
  });

  it('rejects labels containing ":" or "/" (KV key collision)', async () => {
    const colon = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'acme:vercel',
      }),
      ctx,
    );
    expect(colon.status).toBe(400);

    const slash = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'acme/vercel',
      }),
      ctx,
    );
    expect(slash.status).toBe(400);
  });

  it('rejects the virtual vercel/<project> owner (unusable client workspace)', async () => {
    const response = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'vercel',
        repoName: 'site',
        label: 'acme',
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(error.code).toBe('invalid_input');
  });

  it('rejects owner/repo that could reshape upstream URLs', async () => {
    const response = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: '../other',
        label: 'acme',
      }),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it('lists accesses with secrets stripped, revokes, and deletes', async () => {
    const created = await data<{ access: { clientId: string }; password: string }>(
      await clientsRoutes.handle(
        '/',
        makeRequest('POST', adminSession, {
          repoOwner: 'octocat',
          repoName: 'site',
          label: 'ACME',
        }),
        ctx,
      ),
    );

    const listResponse = await clientsRoutes.handle('/', makeRequest('GET', null as never), ctx);
    // (unauthenticated list is rejected; use the admin session)
    expect(listResponse.status).toBe(401);

    const listed = await data<Array<Record<string, unknown>>>(
      await clientsRoutes.handle('/', makeRequest('GET', adminSession), ctx),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.clientId).toBe(created.access.clientId);
    for (const secret of ['passwordHash', 'salt', 'githubToken', 'failedAttempts', 'lockedUntil']) {
      expect(listed[0]).not.toHaveProperty(secret);
    }

    const revoked = await data<{ revoked: boolean }>(
      await clientsRoutes.handle(
        `/${created.access.clientId}/revoke`,
        makeRequest('POST', adminSession),
        ctx,
      ),
    );
    expect(revoked.revoked).toBe(true);

    const deleted = await clientsRoutes.handle(
      `/${created.access.clientId}`,
      makeRequest('DELETE', adminSession),
      ctx,
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await data<unknown[]>(
      await clientsRoutes.handle('/', makeRequest('GET', adminSession), ctx),
    );
    expect(afterDelete).toHaveLength(0);
  });

  it('resets a password and returns the new one once', async () => {
    const created = await data<{ access: { clientId: string }; password: string }>(
      await clientsRoutes.handle(
        '/',
        makeRequest('POST', adminSession, {
          repoOwner: 'octocat',
          repoName: 'site',
          label: 'ACME',
        }),
        ctx,
      ),
    );

    const reset = await data<{ password: string }>(
      await clientsRoutes.handle(
        `/${created.access.clientId}/reset-password`,
        makeRequest('POST', adminSession),
        ctx,
      ),
    );
    expect(reset.password).toHaveLength(14);
    expect(reset.password).not.toBe(created.password);

    // The old password no longer verifies; the new one does.
    const oldLogin = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId: created.access.clientId, password: created.password }),
      ctx,
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId: created.access.clientId, password: reset.password }),
      ctx,
    );
    expect(newLogin.status).toBe(200);
  });

  it('creates an access with a language preference and validates it', async () => {
    const response = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'ACME Corp',
        language: 'fr',
      }),
      ctx,
    );
    expect(response.status).toBe(201);

    const created = await data<{ access: { clientId: string; language?: string }; password: string }>(
      response,
    );
    expect(created.access.language).toBe('fr');

    const invalid = await clientsRoutes.handle(
      '/',
      makeRequest('POST', adminSession, {
        repoOwner: 'octocat',
        repoName: 'site',
        label: 'ACME',
        language: 'de',
      }),
      ctx,
    );
    expect(invalid.status).toBe(400);
  });

  it('updates the client language and validates the payload', async () => {
    const created = await data<{ access: { clientId: string }; password: string }>(
      await clientsRoutes.handle(
        '/',
        makeRequest('POST', adminSession, {
          repoOwner: 'octocat',
          repoName: 'site',
          label: 'ACME',
        }),
        ctx,
      ),
    );

    const updated = await data<{ clientId: string; language?: string }>(
      await clientsRoutes.handle(
        `/${created.access.clientId}/language`,
        makeRequest('POST', adminSession, { language: 'fr' }),
        ctx,
      ),
    );
    expect(updated.clientId).toBe(created.access.clientId);
    expect(updated.language).toBe('fr');

    // Persisted on the record: the list endpoint now reports it.
    const listed = await data<Array<{ language?: string }>>(
      await clientsRoutes.handle('/', makeRequest('GET', adminSession), ctx),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.language).toBe('fr');

    // Invalid or missing language → 400.
    const invalid = await clientsRoutes.handle(
      `/${created.access.clientId}/language`,
      makeRequest('POST', adminSession, { language: 'de' }),
      ctx,
    );
    expect(invalid.status).toBe(400);

    const missing = await clientsRoutes.handle(
      `/${created.access.clientId}/language`,
      makeRequest('POST', adminSession, {}),
      ctx,
    );
    expect(missing.status).toBe(400);

    // Unknown id → 404 like the sibling routes.
    const notFound = await clientsRoutes.handle(
      '/nope-1234/language',
      makeRequest('POST', adminSession, { language: 'fr' }),
      ctx,
    );
    expect(notFound.status).toBe(404);
  });
});

describe('client login', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let adminSession: string;
  let clientId: string;
  let password: string;

  beforeEach(async () => {
    const mocked = mockKv();
    kv = mocked.kv;
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession(ADMIN_TOKEN, {
      id: 1,
      login: 'octocat',
      name: null,
      avatarUrl: null,
    });
    const created = await data<{ access: { clientId: string }; password: string }>(
      await clientsRoutes.handle(
        '/',
        makeRequest('POST', adminSession, {
          repoOwner: 'octocat',
          repoName: 'site',
          label: 'ACME',
        }),
        ctx,
      ),
    );
    clientId = created.access.clientId;
    password = created.password;
  });

  it('signs in with valid credentials and returns a client session', async () => {
    const response = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId, password }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-cms_session=');

    const info = await data<{ kind: string; repoLock: { owner: string; repo: string } }>(response);
    expect(info.kind).toBe('client');
    expect(info.repoLock).toEqual({ owner: 'octocat', repo: 'site' });
  });

  it('rejects unknown IDs and wrong passwords', async () => {
    const unknown = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId: 'nobody-0000', password }),
      ctx,
    );
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_credentials',
    );

    const wrong = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId, password: 'nope' }),
      ctx,
    );
    expect(wrong.status).toBe(401);
  });

  it('locks the access after five failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await authRoutes.handle(
        '/client-login',
        makeRequest('POST', null, { clientId, password: 'wrong' }),
        ctx,
      );
    }

    // Even the correct password is rejected while locked — and with the SAME
    // generic error as a wrong password, so lockout state is not observable.
    const locked = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId, password }),
      ctx,
    );
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_credentials',
    );
  });

  it('returns byte-identical responses for unknown IDs and wrong passwords', async () => {
    const unknown = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId: 'nobody-0000', password }),
      ctx,
    );
    const wrong = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId, password: 'nope' }),
      ctx,
    );
    expect(unknown.status).toBe(wrong.status);
    expect(JSON.stringify(await unknown.json())).toBe(JSON.stringify(await wrong.json()));
  });

  it('rejects revoked accesses with the revoked code', async () => {
    await clientsRoutes.handle(`/${clientId}/revoke`, makeRequest('POST', adminSession), ctx);

    const response = await authRoutes.handle(
      '/client-login',
      makeRequest('POST', null, { clientId, password }),
      ctx,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('revoked');
  });
});

describe('repository lock', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let clientSession: string;

  const GITHUB_REPO = {
    id: 42,
    name: 'site',
    owner: { login: 'octocat' },
    full_name: 'octocat/site',
    default_branch: 'main',
    description: null,
    private: false,
    html_url: 'https://github.com/octocat/site',
    updated_at: '2026-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    const mocked = mockKv();
    kv = mocked.kv;
    ctx = { env: makeEnv(kv) };
    const sessions = new SessionManager(kv, KEY);
    clientSession = await sessions.createClientSession(
      ADMIN_TOKEN,
      { id: 0, login: 'ACME', name: 'ACME', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/repos/octocat/site');
        return new Response(JSON.stringify(GITHUB_REPO), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows the locked repository', async () => {
    const response = await repositoryRoutes.handle(
      '/octocat/site',
      new Request('http://localhost/api/repositories/octocat/site', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it('rejects any other repository with 403 before touching GitHub', async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockClear();

    const response = await repositoryRoutes.handle(
      '/someone/else',
      new Request('http://localhost/api/repositories/someone/else', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    // The guard fires before any GitHub call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists only the locked repository for GET /', async () => {
    const response = await repositoryRoutes.handle(
      '/',
      new Request('http://localhost/api/repositories', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    const repos = await data<Array<{ fullName: string }>>(response);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.fullName).toBe('octocat/site');
  });
});

describe('ClientStore.list pagination', () => {
  it('pages through KV listings until complete', async () => {
    const record = (id: string) =>
      JSON.stringify({
        clientId: id,
        label: id,
        repo: { owner: 'octocat', repo: 'site' },
        createdBy: 'octocat',
        passwordHash: 'h',
        salt: 's',
        githubToken: 'g',
        createdAt: `2026-01-0${id === 'a' ? 1 : 2}T00:00:00.000Z`,
        lastUsedAt: null,
        revoked: false,
        failedAttempts: 0,
        lockedUntil: null,
      });
    const backing = new Map([
      ['client:a', record('a')],
      ['client:b', record('b')],
    ]);
    const pages = [
      { keys: [{ name: 'client:a' }], list_complete: false, cursor: 'page-2' },
      { keys: [{ name: 'client:b' }], list_complete: true },
    ];
    const kv = {
      get: (key: string) => backing.get(key) ?? null,
      list: vi.fn(async () => pages.shift()!),
    } as unknown as KVNamespace;

    const store = new ClientStore(kv, KEY);
    const listed = await store.list();

    expect(listed.map((entry) => entry.clientId).sort()).toEqual(['a', 'b']);
    expect(vi.mocked(kv.list).mock.calls).toHaveLength(2);
  });
});
