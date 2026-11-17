/**
 * Tests for the encrypted session store.
 *
 * Verifies that GitHub tokens are encrypted at rest in KV (never stored as
 * plaintext), round-trip correctly, are rejected under a wrong key, and that
 * a missing/invalid key fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@cms/shared';
import { SessionManager } from './session';
import { GitHubGrantStore } from './githubGrant';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';
const USER: UserProfile = { id: 1, login: 'octocat', name: null, avatarUrl: null };
const TOKEN = 'ghp_secret-github-token-123';

/** Minimal in-memory KVNamespace mock (only put/get/delete are exercised). */
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
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('SessionManager encryption', () => {
  let kv: KVNamespace;
  let store: Map<string, { value: string }>;

  beforeEach(() => {
    ({ kv, store } = mockKv());
  });

  it('round-trips a GitHub token and never stores it as plaintext', async () => {
    const sessions = new SessionManager(kv, KEY);
    const token = await sessions.createSession(TOKEN, USER);

    // The opaque session token is 32 random bytes (hex).
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = store.get(`session:${token}`)!.value;
    expect(stored.includes(TOKEN)).toBe(false); // plaintext never persisted

    const recovered = await sessions.getSession(token);
    expect(recovered?.githubToken).toBe(TOKEN);
  });

  it('returns null for an unknown token', async () => {
    const sessions = new SessionManager(kv, KEY);
    expect(await sessions.getSession('nope')).toBeNull();
  });

  it('returns null under the wrong key (fail closed, no partial record)', async () => {
    const sessions = new SessionManager(kv, KEY);
    const token = await sessions.createSession(TOKEN, USER);

    const other = new SessionManager(kv, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(await other.getSession(token)).toBeNull();
  });

  it('throws when the encryption key is missing or the wrong length', async () => {
    await expect(new SessionManager(kv, '').createSession(TOKEN, USER)).rejects.toThrow(
      /SESSION_ENCRYPTION_KEY/,
    );
    await expect(new SessionManager(kv, 'short').createSession(TOKEN, USER)).rejects.toThrow();
  });
});

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

const OAUTH = { clientId: 'cid', clientSecret: 'secret' };

describe('SessionManager token refresh', () => {
  let kv: KVNamespace;
  let store: Map<string, { value: string }>;

  beforeEach(() => {
    ({ kv, store } = mockKv());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createSession persists the expiry', async () => {
    const sessions = new SessionManager(kv, KEY);
    const token = await sessions.createSession(TOKEN, USER, 123);
    const stored = JSON.parse(store.get(`session:${token}`)!.value) as {
      githubTokenExpiresAt?: number;
    };
    expect(stored.githubTokenExpiresAt).toBe(123);
    const recovered = await sessions.getSession(token);
    expect(recovered?.githubTokenExpiresAt).toBe(123);
  });

  it('getSession leaves an unexpired token alone', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const expiry = Date.now() + 3600_000;
    const token = await sessions.createSession(TOKEN, USER, expiry);
    await new GitHubGrantStore(kv, KEY).save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await sessions.getSession(token);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recovered?.githubToken).toBe(TOKEN);
  });

  it('getSession refreshes a near-expiry admin token and persists the cache', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const token = await sessions.createSession(TOKEN, USER, Date.now() + 60_000);
    await new GitHubGrantStore(kv, KEY).save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rotatedResponse()));
    const recovered = await sessions.getSession(token);
    expect(recovered?.githubToken).toBe('gho_dummy-b');
    const stored = JSON.parse(store.get(`session:${token}`)!.value) as {
      githubTokenExpiresAt?: number | null;
    };
    expect(stored.githubTokenExpiresAt).toBeGreaterThan(Date.now() + 28700_000);
    const grant = await new GitHubGrantStore(kv, KEY).load('octocat');
    expect(grant?.accessToken).toBe('gho_dummy-b');
  });

  it('getSession returns null when expired and the grant is dead', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const token = await sessions.createSession(TOKEN, USER, Date.now() - 1000);
    await new GitHubGrantStore(kv, KEY).save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: null,
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not fetch');
      }),
    );
    expect(await sessions.getSession(token)).toBeNull();
  });

  it('getSession refreshes a client session through its connectionOwner grant', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const token = await sessions.createClientSession(
      TOKEN,
      USER,
      { owner: 'octocat', repo: 'site' },
      'admin-login',
      'fr',
      'c1',
      Date.now() + 60_000,
    );
    await new GitHubGrantStore(kv, KEY).save('admin-login', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(rotatedResponse());
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await sessions.getSession(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recovered?.githubToken).toBe('gho_dummy-b');
  });

  it('legacy sessions without expiry never refresh', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const token = await sessions.createSession(TOKEN, USER);
    await new GitHubGrantStore(kv, KEY).save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await sessions.getSession(token);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recovered?.githubToken).toBe(TOKEN);
  });

  it('no oauth config disables refresh', async () => {
    const sessions = new SessionManager(kv, KEY);
    const token = await sessions.createSession(TOKEN, USER, Date.now() + 60_000);
    await new GitHubGrantStore(kv, KEY).save('octocat', {
      accessToken: 'gho_dummy-a',
      refreshToken: 'ghr_dummy-r',
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 15897600_000,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await sessions.getSession(token);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recovered?.githubToken).toBe(TOKEN);
  });

  it('sliding renewal preserves githubTokenExpiresAt', async () => {
    const sessions = new SessionManager(kv, KEY, OAUTH);
    const expiry = Date.now() + 3600_000;
    const token = await sessions.createSession(TOKEN, USER, expiry);
    // Hand-edit lastRefreshedAt to 25h ago via the raw store map.
    const raw = store.get(`session:${token}`)!.value;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.lastRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.set(`session:${token}`, { value: JSON.stringify(parsed) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not fetch');
      }),
    );
    await sessions.getSession(token);
    const after = JSON.parse(store.get(`session:${token}`)!.value) as {
      githubTokenExpiresAt?: number | null;
    };
    expect(after.githubTokenExpiresAt).toBe(expiry);
  });
});
