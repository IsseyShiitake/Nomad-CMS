/**
 * Tests for the hosting-platform connection store.
 *
 * Verifies the KV key layout (per admin + platform), that stored tokens are
 * encrypted at rest (raw KV value never contains the plaintext), that
 * decryption round-trips, corrupt records fail closed, and that touch()
 * patches only the requested fields.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionStore } from './connections';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

/** Minimal in-memory KVNamespace mock (put/get/delete). */
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

/** Direct store access helper — records hold the encrypted token. */
describe('ConnectionStore', () => {
  it('encrypts the token at rest under deploy:<owner>:<platform>', async () => {
    const { kv, store } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    await connections.put({
      platform: 'cloudflare',
      owner: 'octocat',
      token: 'cf-plain-secret',
      accountId: 'acc-1',
      accountName: 'My Account',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });

    const raw = store.get('deploy:octocat:cloudflare');
    expect(raw).toBeDefined();
    expect(raw).not.toContain('cf-plain-secret');

    const decrypted = await connections.get('octocat', 'cloudflare');
    expect(decrypted!.token).toBe('cf-plain-secret');
    expect(decrypted!.accountId).toBe('acc-1');
  });

  it('uses separate keys per admin and platform', async () => {
    const { kv, store } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    await connections.put({
      platform: 'vercel',
      owner: 'octocat',
      token: 'v-1',
      accountId: null,
      accountName: null,
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });
    await connections.put({
      platform: 'cloudflare',
      owner: 'octocat',
      token: 'cf-1',
      accountId: 'a',
      accountName: null,
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });
    await connections.put({
      platform: 'vercel',
      owner: 'octopus',
      token: 'v-2',
      accountId: null,
      accountName: null,
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });

    expect(Array.from(store.keys()).sort()).toEqual([
      'deploy:octocat:cloudflare',
      'deploy:octocat:vercel',
      'deploy:octopus:vercel',
    ]);
  });

  it('returns null for missing connections', async () => {
    const { kv } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    expect(await connections.get('nobody', 'vercel')).toBeNull();
  });

  it('fails closed on corrupt ciphertext', async () => {
    const { kv, store } = mockKv();
    store.set('deploy:octocat:vercel', JSON.stringify({ token: 'AAAA@@@@not-base64' }));
    const connections = new ConnectionStore(kv, KEY);

    expect(await connections.get('octocat', 'vercel')).toBeNull();
  });

  it('delete() reports whether a connection existed', async () => {
    const { kv } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    expect(await connections.delete('octocat', 'vercel')).toBe(false);

    await connections.put({
      platform: 'vercel',
      owner: 'octocat',
      token: 'v-1',
      accountId: null,
      accountName: null,
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });
    expect(await connections.delete('octocat', 'vercel')).toBe(true);
    expect(await connections.get('octocat', 'vercel')).toBeNull();
  });

  it('touch() patches lastUsedAt and tokenInvalid without losing the token', async () => {
    const { kv } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    await connections.put({
      platform: 'cloudflare',
      owner: 'octocat',
      token: 'cf-1',
      accountId: 'acc',
      accountName: 'Account',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: null,
      tokenInvalid: false,
    });

    await connections.touch('octocat', 'cloudflare', {
      lastUsedAt: '2026-09-02T00:00:00Z',
      tokenInvalid: true,
    });

    const updated = await connections.get('octocat', 'cloudflare');
    expect(updated!.token).toBe('cf-1');
    expect(updated!.lastUsedAt).toBe('2026-09-02T00:00:00Z');
    expect(updated!.tokenInvalid).toBe(true);
  });

  it('toConnection() strips the token and keeps public fields', async () => {
    const { kv } = mockKv();
    const connections = new ConnectionStore(kv, KEY);

    await connections.put({
      platform: 'vercel',
      owner: 'octocat',
      token: 'v-secret',
      refreshToken: 'v-refresh',
      source: 'oauth',
      tokenExpiresAt: '2026-09-03T00:00:00Z',
      accountId: 'team_1',
      accountName: 'My Team',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: '2026-09-02T00:00:00Z',
      tokenInvalid: false,
    });

    const record = await connections.get('octocat', 'vercel');
    expect(record!.refreshToken).toBe('v-refresh');
    const connection = connections.toConnection(record!);
    expect(connection).toEqual({
      platform: 'vercel',
      accountName: 'My Team',
      accountId: 'team_1',
      createdAt: '2026-09-01T00:00:00Z',
      lastUsedAt: '2026-09-02T00:00:00Z',
      tokenInvalid: false,
      source: 'oauth',
      tokenExpiresAt: '2026-09-03T00:00:00Z',
    });
    expect(JSON.stringify(connection)).not.toContain('v-secret');
    expect(JSON.stringify(connection)).not.toContain('v-refresh');
  });
});
