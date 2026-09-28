/**
 * Tests for the deploy error → API response mapping.
 *
 * Verifies that auth failures become 401 with the platform-token-invalid
 * marker, rate limits surface 429 with Retry-After, 404s pass through, and
 * unknown errors fall back without leaking internals.
 */
import { describe, expect, it } from 'vitest';
import { PlatformError, PlatformRateLimitError, mapDeployError } from './index';

async function body(response: Response): Promise<{ error?: { code: string; message: string } }> {
  return (await response.json()) as { error?: { code: string; message: string } };
}

describe('mapDeployError', () => {
  const fallback = { code: 'deploy_error', message: 'Failed', status: 502 };

  it('maps a platform 401 to 401 with the token-invalid marker', async () => {
    const r = mapDeployError(new PlatformError(401, null, 'unauthorized'), fallback);
    expect(r.status).toBe(401);
    expect((await body(r)).error?.code).toBe('platform_token_invalid');
    expect(r.headers.get('x-cms-platform-token-invalid')).toBe('1');
  });

  it('maps a platform 403 the same as 401 (scoped tokens fail as 403)', async () => {
    const r = mapDeployError(new PlatformError(403, 'insufficient permissions', 'forbidden'), fallback);
    expect(r.status).toBe(401);
    expect(r.headers.get('x-cms-platform-token-invalid')).toBe('1');
  });

  it('maps a rate limit to 429 with Retry-After', async () => {
    const r = mapDeployError(new PlatformRateLimitError(45), fallback);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('45');
    expect((await body(r)).error?.code).toBe('rate_limited');
  });

  it('maps a 429 without Retry-After to a 60s default', async () => {
    const r = mapDeployError(new PlatformRateLimitError(null), fallback);
    expect(r.headers.get('Retry-After')).toBe('60');
  });

  it('maps a platform 404 to 404', async () => {
    const r = mapDeployError(new PlatformError(404, null, 'missing'), fallback);
    expect(r.status).toBe(404);
    expect((await body(r)).error?.code).toBe('not_found');
  });

  it('maps a platform 400 with its upstream detail', async () => {
    const r = mapDeployError(
      new PlatformError(400, 'no git source configured', 'bad request'),
      fallback,
    );
    expect(r.status).toBe(400);
    const parsed = await body(r);
    expect(parsed.error?.code).toBe('platform_bad_request');
    expect(parsed.error?.message).toBe('no git source configured');
  });

  it('maps a platform 5xx to 502 platform_error', async () => {
    const r = mapDeployError(new PlatformError(500, null, 'server error'), fallback);
    expect(r.status).toBe(502);
    expect((await body(r)).error?.code).toBe('platform_error');
  });

  it('falls back for an unrecognized error', async () => {
    const r = mapDeployError(new Error('boom'), fallback);
    expect(r.status).toBe(502);
    expect((await body(r)).error?.code).toBe('deploy_error');
  });
});
