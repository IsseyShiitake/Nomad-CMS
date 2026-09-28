/**
 * Tests for the API client's 401 handling.
 *
 * Only session-dead 401s (error code "unauthorized") may sign the UI out.
 * The backend also answers 401 with platform_token_invalid (a rejected
 * hosting token) while the CMS session is healthy — those must NOT drop
 * the app to the sign-in screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, setUnauthorizedHandler } from './client';

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

/** Stubs fetch to answer once with the given status + JSON body. */
function stubJson(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('api client 401 handling', () => {
  it('fires the unauthorized handler only for session-dead 401s', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    // A rejected platform token is NOT a dead session — the handler stays
    // silent (typing a wrong token in Settings must not sign the user out).
    stubJson(401, { error: { code: 'platform_token_invalid', message: 'rejected' } });
    await expect(apiRequest('/api/deploy/connections')).rejects.toThrow('rejected');
    expect(handler).not.toHaveBeenCalled();

    // The session-dead code does fire it.
    stubJson(401, { error: { code: 'unauthorized', message: 'Not authenticated' } });
    await expect(apiRequest('/api/deploy/connections')).rejects.toThrow('Not authenticated');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('skips the handler for /api/auth paths (the callback handles its own errors)', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    stubJson(401, { error: { code: 'unauthorized', message: 'Not authenticated' } });
    await expect(apiRequest('/api/auth/session')).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('sends Content-Type only when a request body is present', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/api/health');
    const getHeaders = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(getHeaders.get('Content-Type')).toBeNull();

    await apiRequest('/api/auth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: 'x', state: 'y' }),
    });
    const postHeaders = fetchMock.mock.calls[1]![1]!.headers as Headers;
    expect(postHeaders.get('Content-Type')).toBe('application/json');
  });
});
