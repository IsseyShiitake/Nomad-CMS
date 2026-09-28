/**
 * Unit tests for the deferred platform-login intent.
 *
 * sessionStorage is stubbed with a plain map: the harness's jsdom flags
 * storage as unavailable, and the module must degrade gracefully anyway
 * (that path is asserted here too).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingPlatformLogin,
  consumePendingPlatformLogin,
  setPendingPlatformLogin,
} from './platformLoginIntent';

function stubSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('platformLoginIntent', () => {
  it('round-trips a fresh intent and consumes it exactly once', () => {
    stubSessionStorage();
    setPendingPlatformLogin('cloudflare');
    expect(consumePendingPlatformLogin()).toBe('cloudflare');
    // Consumed: a second read (e.g. a StrictMode remount) sees nothing.
    expect(consumePendingPlatformLogin()).toBeNull();
  });

  it('drops an intent older than the ten-minute TTL', () => {
    stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T10:00:00Z'));
    setPendingPlatformLogin('vercel');
    vi.setSystemTime(new Date('2026-09-13T10:10:01Z'));
    expect(consumePendingPlatformLogin()).toBeNull();
  });

  it('accepts an intent just inside the TTL', () => {
    stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T10:00:00Z'));
    setPendingPlatformLogin('vercel');
    vi.setSystemTime(new Date('2026-09-13T10:09:59Z'));
    expect(consumePendingPlatformLogin()).toBe('vercel');
  });

  it('clear() removes the intent without consuming it', () => {
    stubSessionStorage();
    setPendingPlatformLogin('cloudflare');
    clearPendingPlatformLogin();
    expect(consumePendingPlatformLogin()).toBeNull();
  });

  it('degrades to null when storage is unavailable or corrupt', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => setPendingPlatformLogin('cloudflare')).not.toThrow();
    expect(consumePendingPlatformLogin()).toBeNull();

    const store = new Map<string, string>([['cms.pending-platform-login', 'not json']]);
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    expect(consumePendingPlatformLogin()).toBeNull();
  });
});
