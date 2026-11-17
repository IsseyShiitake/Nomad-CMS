/**
 * Tests for the GitHub OAuth token pair exchange and refresh grant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCodeForToken, refreshGitHubToken, RefreshTokenRejectedError } from './oauth';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('exchangeCodeForToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchange parses the expiring pair', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          access_token: 'gho_dummy-a',
          token_type: 'bearer',
          scope: 'repo',
          expires_in: 28800,
          refresh_token: 'ghr_dummy-r',
          refresh_token_expires_in: 15897600,
        }),
      ),
    );
    const before = Date.now();
    const pair = await exchangeCodeForToken('cid', 'secret', 'code');
    const after = Date.now();
    expect(pair.accessToken).toBe('gho_dummy-a');
    expect(pair.refreshToken).toBe('ghr_dummy-r');
    expect(pair.accessExpiresAt).toBeGreaterThanOrEqual(before + 28800_000);
    expect(pair.accessExpiresAt!).toBeLessThanOrEqual(after + 28800_000);
    expect(pair.refreshExpiresAt).toBeGreaterThanOrEqual(before + 15897600_000);
    expect(pair.refreshExpiresAt!).toBeLessThanOrEqual(after + 15897600_000);
  });

  it('exchange tolerates a non-expiring response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({ access_token: 'gho_dummy-a', token_type: 'bearer', scope: 'repo' }),
      ),
    );
    const pair = await exchangeCodeForToken('cid', 'secret', 'code');
    expect(pair.accessToken).toBe('gho_dummy-a');
    expect(pair.refreshToken).toBeNull();
    expect(pair.accessExpiresAt).toBeNull();
    expect(pair.refreshExpiresAt).toBeNull();
  });
});

describe('refreshGitHubToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refresh posts the refresh grant and parses the rotated pair', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        access_token: 'gho_dummy-a',
        token_type: 'bearer',
        scope: 'repo',
        expires_in: 28800,
        refresh_token: 'ghr_dummy-r2',
        refresh_token_expires_in: 15897600,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now();
    const pair = await refreshGitHubToken('cid', 'secret', 'ghr_dummy-r');
    const after = Date.now();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=ghr_dummy-r');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=secret');
    expect(pair.accessToken).toBe('gho_dummy-a');
    expect(pair.refreshToken).toBe('ghr_dummy-r2');
    expect(pair.accessExpiresAt).toBeGreaterThanOrEqual(before + 28800_000);
    expect(pair.accessExpiresAt!).toBeLessThanOrEqual(after + 28800_000);
  });

  it('refresh maps bad_refresh_token to RefreshTokenRejectedError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'bad_refresh_token', error_description: '…' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant', error_description: '…' })),
    );
    await expect(refreshGitHubToken('cid', 'secret', 'ghr_dummy-r')).rejects.toBeInstanceOf(
      RefreshTokenRejectedError,
    );
    await expect(refreshGitHubToken('cid', 'secret', 'ghr_dummy-r')).rejects.toBeInstanceOf(
      RefreshTokenRejectedError,
    );
  });

  it('refresh rejects a response missing refresh_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({ access_token: 'gho_dummy-a', expires_in: 28800 }),
      ),
    );
    await expect(refreshGitHubToken('cid', 'secret', 'ghr_dummy-r')).rejects.toThrow();
  });

  it('error messages never contain token values', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'bad_refresh_token', error_description: '…' }))
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'gho_dummy-a', expires_in: 28800 })
        ),
    );
    let msg1 = '';
    try {
      await refreshGitHubToken('cid', 'secret', 'ghr_dummy-r');
    } catch (e) {
      msg1 = e instanceof Error ? e.message : String(e);
    }
    expect(msg1).toBe('bad_refresh_token');
    expect(msg1).not.toContain('ghr_dummy-r');
    expect(msg1).not.toContain('gho_dummy-a');

    let msg2 = '';
    try {
      await refreshGitHubToken('cid', 'secret', 'ghr_dummy-r');
    } catch (e) {
      msg2 = e instanceof Error ? e.message : String(e);
    }
    expect(msg2).not.toContain('ghr_dummy-r');
    expect(msg2).not.toContain('gho_dummy-a');
  });
});
