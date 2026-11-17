/**
 * Tests for the canonical rotating GitHub grant store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTokenPair } from './oauth';
import { RefreshTokenRejectedError } from './oauth';
import { GitHubGrantStore } from './githubGrant';

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
        throw new RefreshTokenRejectedError('bad_refresh_token');
      }),
    );
    // Simulate the other concurrent request rotating the grant before resolve runs:
    // we overwrite KV directly so the re-read sees a fresh, different token.
    // (The fetch stub rejects, but the re-read must recover.)
    await grants.save('octocat', {
      accessToken: 'gho_dummy-b',
      refreshToken: 'ghr_dummy-r2',
      accessExpiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
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
});
