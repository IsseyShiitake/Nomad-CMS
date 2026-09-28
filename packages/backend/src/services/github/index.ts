/**
 * GitHub service module.
 *
 * Server-side access to the GitHub API. All GitHub credentials
 * are held by the Worker; nothing here is ever sent to the
 * frontend.
 */

import type { SessionKind } from '@cms/shared';
import { jsonError } from '../../core/http';
import {
  GitHubClient,
  MergeConflictError,
  RateLimitError,
  TreeTruncatedError,
  GitHubError,
  isValidOwnerRepo,
} from './client';

export { GitHubClient, MergeConflictError, RateLimitError, TreeTruncatedError, GitHubError, isValidOwnerRepo };
export type { ReadFileResult } from './client';

/** Fallback used when an error is not a recognized GitHub error. */
export interface ErrorFallback {
  code: string;
  message: string;
  status: number;
}

/**
 * Maps a thrown GitHub-client error to the appropriate API response.
 *
 * Translates the upstream HTTP status (404, 401, 403, 5xx) instead of
 * collapsing every failure into a generic 502, and surfaces rate limits as
 * 429 with Retry-After and truncated trees as a distinct code. Merge
 * conflicts remain 409.
 */
export function mapGitHubError(
  error: unknown,
  fallback: ErrorFallback,
  sessionKind?: SessionKind,
): Response {
  if (error instanceof RateLimitError) {
    return jsonError(
      'rate_limited',
      'GitHub rate limit exceeded — please retry shortly.',
      429,
      { 'Retry-After': String(error.retryAfter ?? 60) },
    );
  }
  if (error instanceof TreeTruncatedError) {
    return jsonError('repo_too_large', 'Repository is too large to list fully.', 502);
  }
  if (error instanceof MergeConflictError) {
    return jsonError('merge_conflict', error.message, 409);
  }
  if (error instanceof GitHubError) {
    if (error.status === 404) return jsonError('not_found', 'Not found on GitHub', 404);
    // A client session rides the ADMIN's stored GitHub token. When that
    // backing token dies, the client's own login is still legitimate — so
    // respond 403 WITHOUT the x-cms-github-token-invalid marker (the router
    // purges sessions only for the marked admin 401). The frontend then
    // shows a clear "ask the administrator" message instead of silently
    // bouncing the client back to the sign-in screen.
    if (error.status === 401 && sessionKind === 'client') {
      return jsonError(
        'backing_token_invalid',
        'The GitHub connection behind this access has expired or been revoked. Ask the administrator to recreate this access.',
        403,
      );
    }
    // Marker header: the router's purge middleware deletes the session only
    // for this mapped token-invalid 401, not for unauthenticated requests.
    if (error.status === 401)
      return jsonError('unauthorized', 'GitHub token is invalid or expired', 401, {
        'x-cms-github-token-invalid': '1',
      });
    if (error.status === 403) return jsonError('forbidden', 'GitHub denied the request', 403);
    return jsonError('github_error', `GitHub error (HTTP ${error.status})`, 502);
  }
  console.error('Unexpected GitHub client error:', error instanceof Error ? error.message : error);
  return jsonError(fallback.code, fallback.message, fallback.status);
}
