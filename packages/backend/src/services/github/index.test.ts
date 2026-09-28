/**
 * Tests for GitHub error → API response mapping.
 *
 * Verifies that upstream GitHub statuses translate to the right HTTP codes
 * (instead of every failure becoming a generic 502), that rate limits carry
 * Retry-After, and that merge conflicts remain 409.
 */
import { describe, expect, it } from 'vitest';
import {
  GitHubError,
  MergeConflictError,
  RateLimitError,
  TreeTruncatedError,
  mapGitHubError,
} from './index';

async function body(response: Response): Promise<{ error?: { code: string; message: string } }> {
  return (await response.json()) as { error?: { code: string; message: string } };
}

describe('mapGitHubError', () => {
  const fallback = { code: 'github_error', message: 'Failed', status: 502 };

  it('maps a 404 upstream to 404', async () => {
    const r = mapGitHubError(new GitHubError(404, 'not found'), fallback);
    expect(r.status).toBe(404);
    expect((await body(r)).error?.code).toBe('not_found');
  });

  it('maps a 401 upstream to 401 with the token-invalid marker', async () => {
    const r = mapGitHubError(new GitHubError(401, 'bad credentials'), fallback);
    expect(r.status).toBe(401);
    expect((await body(r)).error?.code).toBe('unauthorized');
    // Marker consumed by the router's purge middleware.
    expect(r.headers.get('x-cms-github-token-invalid')).toBe('1');
  });

  it('maps a 401 upstream to 403 backing_token_invalid for client sessions', async () => {
    const r = mapGitHubError(new GitHubError(401, 'bad credentials'), fallback, 'client');
    expect(r.status).toBe(403);
    expect((await body(r)).error?.code).toBe('backing_token_invalid');
    // No marker: the router must NOT purge a client's CMS session.
    expect(r.headers.get('x-cms-github-token-invalid')).toBeNull();
  });

  it('maps a 403 upstream to 403', async () => {
    const r = mapGitHubError(new GitHubError(403, 'forbidden'), fallback);
    expect(r.status).toBe(403);
    expect((await body(r)).error?.code).toBe('forbidden');
  });

  it('maps a 5xx upstream to 502', async () => {
    const r = mapGitHubError(new GitHubError(500, 'server error'), fallback);
    expect(r.status).toBe(502);
    expect((await body(r)).error?.code).toBe('github_error');
  });

  it('maps a rate limit to 429 with Retry-After', async () => {
    const r = mapGitHubError(new RateLimitError(30), fallback);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('30');
    expect((await body(r)).error?.code).toBe('rate_limited');
  });

  it('maps a truncated tree to 502 repo_too_large', async () => {
    const r = mapGitHubError(new TreeTruncatedError(), fallback);
    expect(r.status).toBe(502);
    expect((await body(r)).error?.code).toBe('repo_too_large');
  });

  it('maps a merge conflict to 409', async () => {
    const r = mapGitHubError(new MergeConflictError(), fallback);
    expect(r.status).toBe(409);
    expect((await body(r)).error?.code).toBe('merge_conflict');
  });

  it('falls back for an unrecognized error', async () => {
    const r = mapGitHubError(new Error('boom'), fallback);
    expect(r.status).toBe(502);
    expect((await body(r)).error?.code).toBe('github_error');
  });
});
