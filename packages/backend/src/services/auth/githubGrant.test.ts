/**
 * Tests for the canonical rotating GitHub grant store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTokenPair } from './oauth';
import { RefreshTokenRejectedError } from './oauth';
import { GitHubGrantStore, keepAliveGrants } from './githubGrant';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

function mockKv() {
  const store = new Map<string, { value: string; options?: { expirationTtl?: number } }>();
  const kv = {
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, options });
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rotatedResponse(accessToken = 'gho_dummy-b', refreshToken = 'ghr_dummy-r2') {
  return jsonResponse({
    access_token: accessToken,
    token_type: 'bearer',
    scope: 'repo',
    expires_in: 28800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15897600,
  });
}

describe('GitHubGrantStore', () => {
  let kv: KVNamespace;
  let store: Map<string, { value: string; options?: { expirationTtl?: number } }>;

  beforeEach(() => {
    ({ kv, store } = mockKv());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a grant and never stores plaintext', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    const pair: GitHubTokenPair = {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    };
    await grants.save('octocat', pair);
    const raw = store.get('github-grant:octocat')!.value;
    expect(raw).not.toContain('gho_dummy-a');
    expect(raw).not.toContain('ghr_dummy-r');
    const loaded = await grants.load('octocat');
    expect(loaded).toEqual(pair);
  });

  it('save sets the refresh-expiry TTL; non-expiring grant has none', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const ttl = store.get('github-grant:octocat')!.options?.expirationTtl;
    expect(ttl).toBeGreaterThan(15897600 - 2);
    expect(ttl).toBeLessThanOrEqual(15897600);

    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    });
    const opts = store.get('github-grant:octocat')!.options;
    expect(opts === undefined || opts.expirationTtl === undefined).toBe(true);
  });

  it('load returns null for missing or corrupt records', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    expect(await grants.load('missing')).toBeNull();
    await kv.put('github-grant:octocat', 'garbage-not-json');
    expect(await grants.load('octocat')).toBeNull();
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const wrongKey = new GitHubGrantStore(kv, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(await wrongKey.load('octocat')).toBeNull();
  });

  it('resolve returns the cached token without fetching when fresh', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not fetch');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result?.accessToken).toBe('gho_dummy-a');
    expect(result?.accessExpiresAt).toBeGreaterThan(Date.now());
  });

  it('resolve returns the cached token forever when non-expiring', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not fetch');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result).toEqual({ accessToken: 'gho_dummy-a', accessExpiresAt: null });
  });

  it('resolve refreshes an expired grant and persists the rotated pair', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rotatedResponse()));
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result?.accessToken).toBe('gho_dummy-b');
    const loaded = await grants.load('octocat');
    expect(loaded?.accessToken).toBe('gho_dummy-b');
    expect(loaded?.refreshToken).toBe('ghr_dummy-r2');
  });

  it('resolve refreshes inside the margin', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rotatedResponse()));
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result?.accessToken).toBe('gho_dummy-b');
  });

  it('recovers via grant re-read when a concurrent request already rotated it', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Simulate the other concurrent request rotating the grant while
        // this request's refresh is in flight: save the rotated pair, then
        // reject this caller's refresh as GitHub would (single-use rotation).
        await new GitHubGrantStore(kv, KEY).save('octocat', {
          accessToken: 'gho_dummy-b',
          refreshToken: 'ghr_dummy-r2',
          accessExpiresAt: Date.now() + 28800_000,
          refreshExpiresAt: Date.now() + 15897600_000,
        });
        throw new RefreshTokenRejectedError('bad_refresh_token');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result?.accessToken).toBe('gho_dummy-b');
  });

  it('rejected refresh with no rotation removes the grant and returns null', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new RefreshTokenRejectedError('bad_refresh_token');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
    expect(await grants.load('octocat')).toBeNull();
  });

  it('serves cached token on transient failure while still valid', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result?.accessToken).toBe('gho_dummy-a');
  });

  it('fails closed after hard expiry on transient failure', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    await grants.save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
  });

  it('missing grant returns null', async () => {
    const grants = new GitHubGrantStore(kv, KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not fetch');
      }),
    );
    const result = await grants.resolveFreshAccessToken('missing', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
  });

  it('rejected refresh with a stale reread removes the grant and returns null', async () => {
    // Pins the orchestrator review ruling (2026-11-17): when a concurrent
    // rotation is not yet visible in KV, the recovery re-read observes the
    // stale grant and the rejected refresh routes into remove(), deleting
    // whatever the winner wrote. Accepted: backed sessions fail closed at
    // their next hard expiry (≤ 8 h) and recover via the admin signing in
    // again. A mock KV has no lag, so "stale reread" here is the
    // unchanged-grant case; the test pins the routing, not the lag.
    // Seed values flow from the rotatedResponse fixture helper rather than
    // new literals; none of them are asserted by this test.
    const grants = new GitHubGrantStore(kv, KEY);
    const seed = (await rotatedResponse().json()) as {
      access_token: string;
      refresh_token: string;
    };
    await grants.save('octocat', {
      accessToken: seed.access_token,
      refreshToken: seed.refresh_token,
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new RefreshTokenRejectedError('bad_refresh_token');
      }),
    );
    const result = await grants.resolveFreshAccessToken('octocat', {
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
    expect(await grants.load('octocat')).toBeNull();
  });
});

describe('keepAliveGrants (dormant-login cron)', () => {
  let kv: KVNamespace;
  let store: Map<string, { value: string; options?: { expirationTtl?: number } }>;
  const OAUTH = { clientId: 'cid', clientSecret: 'secret' };

  beforeEach(() => {
    ({ kv, store } = mockKv());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedGrant(login: string, overrides: Partial<GitHubTokenPair> = {}) {
    await new GitHubGrantStore(kv, KEY).save(login, {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 15897600_000,
      ...overrides,
    });
  }

  it('rotates a grant whose refresh expiry is inside the 45-day threshold', async () => {
    await seedGrant('octocat', { refreshExpiresAt: Date.now() + 30 * 86400_000 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rotatedResponse()));
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.rotated).toBe(1);
    const loaded = await new GitHubGrantStore(kv, KEY).load('octocat');
    expect(loaded?.accessToken).toBe('gho_dummy-b');
    expect(loaded?.refreshToken).toBe('ghr_dummy-r2');
    // The rotated pair resets the six-month clock and the KV TTL with it.
    expect(loaded?.refreshExpiresAt).toBeGreaterThan(Date.now() + 15897600_000 - 5000);
    expect(store.get('github-grant:octocat')!.options?.expirationTtl).toBeGreaterThan(15897600 - 5);
  });

  it('leaves a grant whose refresh expiry is far away untouched', async () => {
    await seedGrant('octocat');
    const before = store.get('github-grant:octocat')!.value;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('keep-alive must not fetch for a healthy grant');
      }),
    );
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.rotated).toBe(0);
    expect(store.get('github-grant:octocat')!.value).toBe(before);
  });

  it('leaves non-expiring grants untouched', async () => {
    await seedGrant('octocat', {
      refreshToken: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('keep-alive must not fetch for a non-expiring grant');
      }),
    );
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.rotated).toBe(0);
    expect(await new GitHubGrantStore(kv, KEY).load('octocat')).not.toBeNull();
  });

  it('removes a grant whose refresh is rejected', async () => {
    await seedGrant('octocat', { refreshExpiresAt: Date.now() + 30 * 86400_000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new RefreshTokenRejectedError('bad_refresh_token');
      }),
    );
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.removed).toBe(1);
    expect(await new GitHubGrantStore(kv, KEY).load('octocat')).toBeNull();
  });

  it('keeps a grant on transient failure and reports it', async () => {
    await seedGrant('octocat', { refreshExpiresAt: Date.now() + 30 * 86400_000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.failed).toBe(1);
    expect((await new GitHubGrantStore(kv, KEY).load('octocat'))?.accessToken).toBe('gho_dummy-a');
  });

  it('walks every grant key', async () => {
    await seedGrant('octocat', { refreshExpiresAt: Date.now() + 30 * 86400_000 });
    await seedGrant('other');
    const otherBefore = store.get('github-grant:other')!.value;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rotatedResponse()));
    const summary = await keepAliveGrants(kv, KEY, OAUTH);
    expect(summary.rotated).toBe(1);
    expect(store.get('github-grant:other')!.value).toBe(otherBefore);
  });
});
