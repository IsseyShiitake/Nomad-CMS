/**
 * Tests for the OAuth authorize/exchange state binding and cookie flags.
 *
 * Covers: GET /authorize issues a 64-hex state stored in KV and returns an
 * authorize URL carrying it; POST /exchange requires a live state (missing,
 * unknown, or already-consumed states are rejected with 400 oauth_state); a
 * valid state is consumed exactly once; and Set-Cookie flags follow the
 * deployment mode rather than the request scheme.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { sessionCookie } from '../core/http';
import { AUTHORIZE_RATE_LIMIT, AUTHORIZE_RATE_WINDOW_SECONDS } from '../core/rateLimit';
import { authRoutes } from './auth';
import type { RouteContext } from './index';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

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
    GITHUB_CLIENT_ID: 'test-client-id',
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

describe('auth routes', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;

  beforeEach(() => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues an authorize URL with server-side state', async () => {
    const response = await authRoutes.handle(
      '/authorize',
      new Request('http://localhost/api/auth/authorize'),
      ctx,
    );
    expect(response.status).toBe(200);

    const { url } = ((await response.json()) as { data: { url: string } }).data;
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain(
      `redirect_uri=${encodeURIComponent('http://localhost:5173/auth/callback')}`,
    );
    expect(url).toContain('scope=repo');

    const state = new URL(url).searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // The state is bound server-side in KV with a short TTL.
    expect(await kv.get(`oauth-state:${state}`)).toBe('1');
  });

  it('rejects /exchange without a state', async () => {
    const response = await authRoutes.handle(
      '/exchange',
      new Request('http://localhost/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'x' }),
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(error.code).toBe('oauth_state');
  });

  it('rejects /exchange with an unknown state', async () => {
    const response = await authRoutes.handle(
      '/exchange',
      new Request('http://localhost/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'x', state: 'deadbeef' }),
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(error.code).toBe('oauth_state');
  });

  it('exchanges with a planted state and consumes it once', async () => {
    await kv.put('oauth-state:abc123', '1');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'gho_token', token_type: 'bearer', scope: 'repo' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 1, login: 'octocat', name: null, avatar_url: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );

    const response = await authRoutes.handle(
      '/exchange',
      new Request('http://localhost/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'good-code', state: 'abc123' }),
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    // The delete is fire-and-forget; flush microtasks so it lands before
    // the assertion.
    await Promise.resolve();
    await Promise.resolve();
    expect(await kv.get('oauth-state:abc123')).toBeNull();
  });
});

describe('operator pinning (instance_locked)', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;

  // Inert dummy fixtures for the mocked GitHub responses (Mimosa-safe).
  const DUMMY_GH_ACCESS = 'gho_dummy-test-token';

  beforeEach(() => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs one /exchange for the given GitHub login with a planted state. */
  async function exchangeAs(login: string): Promise<Response> {
    await kv.put(`oauth-state:st-${login}`, '1');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: DUMMY_GH_ACCESS, token_type: 'bearer', scope: 'repo' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 1, login, name: null, avatar_url: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    return authRoutes.handle(
      '/exchange',
      new Request('http://localhost/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'good-code', state: `st-${login}` }),
      }),
      ctx,
    );
  }

  it('the first GitHub login claims the operator slot and keeps it', async () => {
    const first = await exchangeAs('octocat');
    expect(first.status).toBe(200);
    expect(await kv.get('operator:login')).toBe('octocat');

    const again = await exchangeAs('octocat');
    expect(again.status).toBe(200);
  });

  it('rejects a different GitHub login with 403 instance_locked and no session', async () => {
    const first = await exchangeAs('octocat');
    expect(first.status).toBe(200);

    const second = await exchangeAs('intruder');
    expect(second.status).toBe(403);
    const { error } = (await second.json()) as { error: { code: string } };
    expect(error.code).toBe('instance_locked');
    // Exactly one session exists (the operator's) — the intruder got none.
    const keys = await kv.list({ prefix: 'session:' });
    expect(keys.keys).toHaveLength(1);
  });

  it('matches the operator claim case-insensitively', async () => {
    const first = await exchangeAs('octocat');
    expect(first.status).toBe(200);

    const again = await exchangeAs('OctoCat');
    expect(again.status).toBe(200);
  });

  it('OPERATOR_LOGIN overrides and rejects any other login before any claim exists', async () => {
    ctx = { env: { ...makeEnv(kv), OPERATOR_LOGIN: 'ravi' } };

    const intruder = await exchangeAs('octocat');
    expect(intruder.status).toBe(403);
    expect(await kv.get('operator:login')).toBeNull();

    const operator = await exchangeAs('ravi');
    expect(operator.status).toBe(200);
    // The pinned operator is mirrored into KV once it first signs in.
    expect(await kv.get('operator:login')).toBe('ravi');
  });

  it('OPERATOR_LOGIN overwrites a stale KV claim from a previous first-login', async () => {
    // An instance that ran unpinned claimed an operator...
    const first = await exchangeAs('octocat');
    expect(first.status).toBe(200);
    expect(await kv.get('operator:login')).toBe('octocat');

    // ...then the env pin arrives: the pinned login still signs in and the
    // stale claim is overwritten (the env var is authoritative).
    ctx = { env: { ...makeEnv(kv), OPERATOR_LOGIN: 'ravi' } };
    const operator = await exchangeAs('ravi');
    expect(operator.status).toBe(200);
    expect(await kv.get('operator:login')).toBe('ravi');
  });
});

describe('cookie deployment mode', () => {
  it('sets Lax+Secure for same-origin https deployments (no CORS allowlist)', () => {
    const request = new Request('http://localhost/api/auth/session');
    const cookie = sessionCookie(true, request, 'tok', 3600, false);
    expect(cookie).toContain('__Host-cms_session=');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('SameSite=None');
  });

  it('sets None+Secure for https deployments with a CORS allowlist', () => {
    const request = new Request('http://localhost/api/auth/session');
    const cookie = sessionCookie(true, request, 'tok', 3600, true);
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
  });

  it('sets Lax without Secure for plain-http local development', () => {
    const request = new Request('https://proxied.example.com/api/auth/session');
    const cookie = sessionCookie(false, request, 'tok', 3600, false);
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });
});

describe('authorize rate limiting (per-IP KV budget guard)', () => {
  let kv: KVNamespace;
  let kvStore: Map<string, { value: string }>;
  let ctx: RouteContext;

  beforeEach(() => {
    ({ kv, store: kvStore } = mockKv());
    ctx = { env: makeEnv(kv) };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs one GET /authorize as the given source IP. */
  function authorizeFrom(ip: string): Promise<Response> {
    return authRoutes.handle(
      '/authorize',
      new Request('http://localhost/api/auth/authorize', {
        headers: { 'CF-Connecting-IP': ip },
      }),
      ctx,
    );
  }

  function stateKeyCount(): number {
    return [...kvStore.keys()].filter((key) => key.startsWith('oauth-state:')).length;
  }

  it('allows a legitimate sign-in and still binds the state', async () => {
    const response = await authorizeFrom('203.0.113.10');
    expect(response.status).toBe(200);
    const { url } = ((await response.json()) as { data: { url: string } }).data;
    const state = new URL(url).searchParams.get('state');
    expect(await kv.get(`oauth-state:${state}`)).toBe('1');
  });

  it('answers 429 past the per-IP limit, writing neither state nor counter', async () => {
    // Exhaust the IP's window budget.
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i += 1) {
      const response = await authorizeFrom('203.0.113.20');
      expect(response.status).toBe(200);
    }
    const statesBefore = stateKeyCount();
    const totalBefore = kvStore.size;

    const limited = await authorizeFrom('203.0.113.20');
    expect(limited.status).toBe(429);
    const { error } = (await limited.json()) as { error: { code: string } };
    expect(error.code).toBe('rate_limited');
    const retryAfter = Number.parseInt(limited.headers.get('Retry-After') ?? '', 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(AUTHORIZE_RATE_WINDOW_SECONDS);

    // The rejected request must not have written anything at all.
    expect(stateKeyCount()).toBe(statesBefore);
    expect(kvStore.size).toBe(totalBefore);
  });

  it('isolates the budget per source IP', async () => {
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i += 1) {
      await authorizeFrom('203.0.113.30');
    }
    expect((await authorizeFrom('203.0.113.30')).status).toBe(429);
    // A different source IP has its own budget.
    expect((await authorizeFrom('203.0.113.31')).status).toBe(200);
    // No-header requests (local dev) share one fail-safe bucket.
    const noHeader = await authRoutes.handle(
      '/authorize',
      new Request('http://localhost/api/auth/authorize'),
      ctx,
    );
    expect(noHeader.status).toBe(200);
  });

  it('starts a fresh budget when the window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i += 1) {
      await authorizeFrom('203.0.113.40');
    }
    expect((await authorizeFrom('203.0.113.40')).status).toBe(429);

    // One millisecond past the window boundary: a new bucket key, a new budget.
    vi.setSystemTime(new Date('2026-10-06T13:00:00.001Z'));
    expect((await authorizeFrom('203.0.113.40')).status).toBe(200);
  });
});
