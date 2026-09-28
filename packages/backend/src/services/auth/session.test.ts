/**
 * Tests for the encrypted session store.
 *
 * Verifies that GitHub tokens are encrypted at rest in KV (never stored as
 * plaintext), round-trip correctly, are rejected under a wrong key, and that
 * a missing/invalid key fails closed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile } from '@cms/shared';
import { SessionManager } from './session';

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
