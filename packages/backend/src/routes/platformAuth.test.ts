/**
 * Tests for the platform-login routes under /api/auth/platform/*.
 *
 * Covers: status availability flags (admin-only, driven by configured
 * client ids), authorize URL construction with a KV-bound state + PKCE
 * verifier, and the exchange — state binding (single-use, bound to the
 * initiating admin), code_verifier forwarding, connection persistence with
 * encrypted tokens, secrets stripped from the response, and error mapping
 * when the platform's token endpoint or userinfo rejects the login.
 *
 * NOTE: every "secret"/"token" string below is an inert dummy fixture for
 * the mocked fetch responses — no real credential is ever present here.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../env';
import { SessionManager } from '../services/auth';
import { ConnectionStore } from '../services/deploy';
import { authRoutes } from './auth';
import type { RouteContext } from './index';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

// Inert dummy fixtures for the mocked platform responses.
const DUMMY_GH_SECRET = 'github-test-dummy';
const DUMMY_VC_SECRET = 'vercel-test-dummy';
const DUMMY_CF_SECRET = 'test-cloudflare-client-secret';
const DUMMY_CF_ACCESS = 'test-cloudflare-access-token';
const DUMMY_CF_REFRESH = 'test-cloudflare-refresh-token';
const DUMMY_VC_ACCESS = 'test-vercel-access-token';
const DUMMY_VC_REFRESH = 'test-vercel-refresh-token';

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

function makeEnv(kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    SESSION_KV: kv,
    ASSETS: {} as Fetcher,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_REDIRECT_URI: 'http://localhost:5173/auth/callback',
    GITHUB_CLIENT_SECRET: DUMMY_GH_SECRET,
    SESSION_ENCRYPTION_KEY: KEY,
    ALLOWED_ORIGINS: '',
    OPERATOR_LOGIN: '',
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: DUMMY_CF_SECRET,
    CLOUDFLARE_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/cloudflare/callback',
    VERCEL_OAUTH_CLIENT_ID: '',
    VERCEL_OAUTH_CLIENT_SECRET: DUMMY_VC_SECRET,
    VERCEL_OAUTH_REDIRECT_URI: 'http://localhost:8787/auth/platform/vercel/callback',
    ...overrides,
  };
}

/** Unwraps the `{ data }` envelope. */
async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

/** Unwraps the `{ error }` envelope. */
async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe('platform auth routes', () => {
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

  function request(path: string, session: string | null, init: RequestInit = {}): Request {
    return new Request(`http://localhost/api/auth${path}`, {
      ...init,
      headers: {
        ...(session ? { Cookie: `__Host-cms_session=${session}` } : {}),
        'X-CSRF-Token': 'x',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  }

  describe('GET /platform/status', () => {
    it('serves availability without a session (configuration only)', async () => {
      const anon = await authRoutes.handle(
        '/platform/status',
        request('/platform/status', null),
        ctx,
      );
      expect(anon.status).toBe(200);
      expect(await data(anon)).toEqual([
        { platform: 'cloudflare', available: true },
        { platform: 'vercel', available: false },
      ]);

      // Client sessions see the same configuration-only payload — it
      // carries no user or connection data.
      const client = await authRoutes.handle(
        '/platform/status',
        request('/platform/status', clientSession),
        ctx,
      );
      expect(client.status).toBe(200);
      expect(await data(client)).toEqual([
        { platform: 'cloudflare', available: true },
        { platform: 'vercel', available: false },
      ]);
    });

    it('reports availability from the configured client ids', async () => {
      const response = await authRoutes.handle(
        '/platform/status',
        request('/platform/status', adminSession),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await data(response)).toEqual([
        { platform: 'cloudflare', available: true },
        { platform: 'vercel', available: false },
      ]);
    });
  });

  describe('GET /platform/:platform/authorize', () => {
    it('requires an admin session (only status is public)', async () => {
      const authorizeAnon = await authRoutes.handle(
        '/platform/cloudflare/authorize',
        request('/platform/cloudflare/authorize', null),
        ctx,
      );
      expect(authorizeAnon.status).toBe(401);

      const authorizeClient = await authRoutes.handle(
        '/platform/cloudflare/authorize',
        request('/platform/cloudflare/authorize', clientSession),
        ctx,
      );
      expect(authorizeClient.status).toBe(403);

      const exchangeAnon = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', null, {
          method: 'POST',
          body: JSON.stringify({ code: 'c', state: 's' }),
        }),
        ctx,
      );
      expect(exchangeAnon.status).toBe(401);
    });

    it('rejects unknown platforms and unsupported methods', async () => {
      const unknown = await authRoutes.handle(
        '/platform/gitlab/authorize',
        request('/platform/gitlab/authorize', adminSession),
        ctx,
      );
      expect(unknown.status).toBe(400);
      expect(await errorCode(unknown)).toBe('invalid_platform');

      const wrongMethod = await authRoutes.handle(
        '/platform/cloudflare/authorize',
        request('/platform/cloudflare/authorize', adminSession, { method: 'POST' }),
        ctx,
      );
      expect(wrongMethod.status).toBe(405);
    });

    it('returns 404 when the platform login is not configured', async () => {
      const response = await authRoutes.handle(
        '/platform/vercel/authorize',
        request('/platform/vercel/authorize', adminSession),
        ctx,
      );
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('platform_login_unavailable');
    });

    it('builds the Cloudflare authorize URL with a KV-bound state + PKCE', async () => {
      const response = await authRoutes.handle(
        '/platform/cloudflare/authorize',
        request('/platform/cloudflare/authorize', adminSession),
        ctx,
      );
      expect(response.status).toBe(200);

      const { url } = await data<{ url: string }>(response);
      expect(url.startsWith('https://dash.cloudflare.com/oauth2/auth?')).toBe(true);
      const params = new URL(url).searchParams;
      expect(params.get('client_id')).toBe('cf-client');
      expect(params.get('redirect_uri')).toBe(
        'http://localhost:8787/auth/platform/cloudflare/callback',
      );
      expect(params.get('scope')).toBe('openid offline_access account.read pages.read pages.write');
      expect(params.get('response_type')).toBe('code');
      expect(params.get('code_challenge_method')).toBe('S256');

      const state = params.get('state')!;
      expect(state).toMatch(/^[0-9a-f]{64}$/);

      // The state record carries the PKCE verifier and the initiating admin.
      const stored = await ctx.env.SESSION_KV.get(`platform-oauth:cloudflare:${state}`);
      expect(stored).not.toBeNull();
      const bound = JSON.parse(stored!) as { verifier: string; owner: string };
      expect(bound.owner).toBe('octocat');
      expect(bound.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The challenge is base64url(SHA-256(verifier)) — a fresh digest check.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(bound.verifier),
      );
      const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(params.get('code_challenge')).toBe(expected);
    });
  });

  describe('POST /platform/:platform/exchange', () => {
    const stateKey = 'platform-oauth:cloudflare:abc123';

    function plantState(verifier: string, owner: string) {
      return ctx.env.SESSION_KV.put(stateKey, JSON.stringify({ verifier, owner }));
    }

    /** Token-endpoint + userinfo responses for a happy Cloudflare login. */
    function happyPlatformFetch() {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: DUMMY_CF_ACCESS,
              refresh_token: DUMMY_CF_REFRESH,
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              email: 'admin@example.com',
              accounts: [{ id: 'acct-1', name: 'Acme' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
    }

    it('requires an admin session (clients and anonymous get 401/403)', async () => {
      const anon = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', null, {
          method: 'POST',
          body: JSON.stringify({ code: 'c', state: 'abc123' }),
        }),
        ctx,
      );
      expect(anon.status).toBe(401);

      const client = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', clientSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'c', state: 'abc123' }),
        }),
        ctx,
      );
      expect(client.status).toBe(403);
      expect(await errorCode(client)).toBe('admin_only');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a missing code, unknown state, and non-POST methods', async () => {
      const noCode = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ state: 'abc123' }),
        }),
        ctx,
      );
      expect(noCode.status).toBe(400);
      expect(await errorCode(noCode)).toBe('invalid_code');

      const noState = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'c' }),
        }),
        ctx,
      );
      expect(noState.status).toBe(400);
      expect(await errorCode(noState)).toBe('oauth_state');

      const wrongMethod = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession),
        ctx,
      );
      expect(wrongMethod.status).toBe(405);
    });

    it('rejects and consumes a state bound to another admin', async () => {
      await plantState('v', 'someone-else');
      const response = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'good-code', state: 'abc123' }),
        }),
        ctx,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('oauth_state');
      // Single-use: the mismatch consumed the state.
      await Promise.resolve();
      await Promise.resolve();
      expect(await ctx.env.SESSION_KV.get(stateKey)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('exchanges the code, forwards the verifier, and stores the connection', async () => {
      await plantState('pkce-verifier', 'octocat');
      happyPlatformFetch();

      const response = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'good-code', state: 'abc123' }),
        }),
        ctx,
      );
      expect(response.status).toBe(201);

      // The token POST is form-encoded and carries the state's verifier.
      const tokenBody = fetchSpy.mock.calls[0]![1]!.body as string;
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://dash.cloudflare.com/oauth2/token');
      expect(tokenBody).toContain('grant_type=authorization_code');
      expect(tokenBody).toContain('code=good-code');
      expect(tokenBody).toContain('code_verifier=pkce-verifier');
      expect(tokenBody).toContain(`client_secret=${DUMMY_CF_SECRET}`);

      const connection = await data<Record<string, unknown>>(response);
      expect(connection.source).toBe('oauth');
      expect(connection.accountId).toBe('acct-1');
      expect(connection.accountName).toBe('admin@example.com');
      expect(connection.tokenInvalid).toBe(false);
      expect(typeof connection.tokenExpiresAt).toBe('string');
      // Secrets never leave the store.
      expect(connection).not.toHaveProperty('token');
      expect(connection).not.toHaveProperty('refreshToken');

      // The stored record decrypts back to the platform tokens (at-rest
      // encryption round-trip) and is keyed by the admin's login.
      const store = new ConnectionStore(ctx.env.SESSION_KV, KEY);
      const record = await store.get('octocat', 'cloudflare');
      expect(record).not.toBeNull();
      expect(record!.token).toBe(DUMMY_CF_ACCESS);
      expect(record!.refreshToken).toBe(DUMMY_CF_REFRESH);
      expect(record!.source).toBe('oauth');
    });

    it('maps a token-endpoint rejection to 401 and persists nothing', async () => {
      await plantState('pkce-verifier', 'octocat');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const response = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'bad-code', state: 'abc123' }),
        }),
        ctx,
      );
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('platform_exchange_failed');

      const store = new ConnectionStore(ctx.env.SESSION_KV, KEY);
      expect(await store.get('octocat', 'cloudflare')).toBeNull();
    });

    it('rejects a Cloudflare login whose userinfo carries no account', async () => {
      await plantState('pkce-verifier', 'octocat');
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: DUMMY_CF_ACCESS }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ email: 'admin@example.com', accounts: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const response = await authRoutes.handle(
        '/platform/cloudflare/exchange',
        request('/platform/cloudflare/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'good-code', state: 'abc123' }),
        }),
        ctx,
      );
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('platform_exchange_failed');
    });

    it('completes a Vercel login with a null accountId', async () => {
      ctx.env = makeEnv(ctx.env.SESSION_KV, { VERCEL_OAUTH_CLIENT_ID: 'v-client' });
      const vercelStateKey = 'platform-oauth:vercel:vstate';
      await ctx.env.SESSION_KV.put(
        vercelStateKey,
        JSON.stringify({ verifier: 'v-verifier', owner: 'octocat' }),
      );
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: DUMMY_VC_ACCESS, refresh_token: DUMMY_VC_REFRESH }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ name: 'Vercel User', email: 'v@example.com' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const response = await authRoutes.handle(
        '/platform/vercel/exchange',
        request('/platform/vercel/exchange', adminSession, {
          method: 'POST',
          body: JSON.stringify({ code: 'good-code', state: 'vstate' }),
        }),
        ctx,
      );
      expect(response.status).toBe(201);
      const connection = await data<Record<string, unknown>>(response);
      expect(connection.source).toBe('oauth');
      expect(connection.accountId).toBeNull();
      expect(connection.accountName).toBe('Vercel User');
    });
  });
});
