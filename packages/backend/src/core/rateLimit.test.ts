/**
 * Tests for the KV-backed rate limiter core.
 *
 * Covers the write-gate behavior and the N2 finding (2026-11-16): KV
 * rejects writes to the same key faster than 1/second, so a parallel burst
 * used to escape the limiter as an unhandled throw (raw 500 from the auth
 * routes). The put is now best-effort — a rejected write allows the request
 * and undercounts instead of failing the route.
 */
import { describe, expect, it } from 'vitest';
import { checkRateLimit } from './rateLimit';

/** Minimal KV mock with an optional failure mode on put. */
function mockKv(options: { putFailsTimes?: number } = {}) {
  const store = new Map<string, string>();
  let putFailures = options.putFailsTimes ?? 0;
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      if (putFailures > 0) {
        putFailures -= 1;
        throw new Error('429 Too Many Requests');
      }
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('checkRateLimit', () => {
  it('counts requests and blocks past the limit within one window', async () => {
    const { kv } = mockKv();
    for (let i = 0; i < 3; i += 1) {
      const verdict = await checkRateLimit({ SESSION_KV: kv }, 'test', '203.0.113.1', 3, 3600);
      expect(verdict.allowed).toBe(true);
    }
    const blocked = await checkRateLimit({ SESSION_KV: kv }, 'test', '203.0.113.1', 3, 3600);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows the request when the counter write is rejected (N2: no raw 500)', async () => {
    const { kv, store } = mockKv({ putFailsTimes: 2 });

    // First two writes are rejected by KV — the requests must still be
    // allowed and NO error may escape the limiter.
    const first = await checkRateLimit({ SESSION_KV: kv }, 'test', '203.0.113.2', 10, 3600);
    expect(first.allowed).toBe(true);
    const second = await checkRateLimit({ SESSION_KV: kv }, 'test', '203.0.113.2', 10, 3600);
    expect(second.allowed).toBe(true);
    expect(store.size).toBe(0); // undercounted, honestly

    // Third write succeeds — counting resumes from the read gate.
    const third = await checkRateLimit({ SESSION_KV: kv }, 'test', '203.0.113.2', 10, 3600);
    expect(third.allowed).toBe(true);
    const keys = [...store.keys()].filter((key) => key.startsWith('ratelimit:test:203.0.113.2:'));
    expect(keys).toHaveLength(1);
    expect(store.get(keys[0]!)).toBe('1');
  });

  it('keys buckets per scope+ip so different scopes do not share budgets', async () => {
    const { kv, store } = mockKv();
    await checkRateLimit({ SESSION_KV: kv }, 'authorize', '203.0.113.3', 10, 3600);
    await checkRateLimit({ SESSION_KV: kv }, 'client-login', '203.0.113.3', 10, 3600);
    expect(store.size).toBe(2);
    expect(await checkRateLimit({ SESSION_KV: kv }, 'authorize', '203.0.113.4', 10, 3600)).toMatchObject({
      allowed: true,
    });
  });
});
