/**
 * Deploy service module.
 *
 * Server-side access to hosting-platform APIs (Cloudflare Pages, Vercel).
 * Platform credentials are held by the Worker only — encrypted at rest in
 * the connection store — and never sent to the frontend.
 */

import { jsonError } from '../../core/http';
import { PlatformError, PlatformRateLimitError } from './http';
import { CloudflarePagesClient } from './cloudflare';
import { VercelClient } from './vercel';
import { ConnectionStore } from './connections';

export { CloudflarePagesClient, VercelClient, ConnectionStore };
export { PlatformError, PlatformRateLimitError };
export { runWithConnection } from './refresh';
export type { PlatformClients } from './refresh';
export type { ConnectionRecord } from './connections';

/** Fallback used when an error is not a recognized platform error. */
export interface DeployErrorFallback {
  code: string;
  message: string;
  status: number;
}

/**
 * Maps a thrown deploy-service error to the appropriate API response.
 *
 * Mirrors mapGitHubError: upstream 401/403 become a 401 carrying the
 * x-cms-platform-token-invalid marker (so the UI can show "reconnect your
 * platform" instead of a generic failure), rate limits surface as 429 with
 * Retry-After, and anything else collapses into the fallback.
 */
export function mapDeployError(error: unknown, fallback: DeployErrorFallback): Response {
  if (error instanceof PlatformRateLimitError) {
    return jsonError(
      'rate_limited',
      'Hosting platform rate limit exceeded — please retry shortly.',
      429,
      { 'Retry-After': String(error.retryAfter ?? 60) },
    );
  }
  if (error instanceof PlatformError) {
    if (error.status === 401 || error.status === 403) {
      return jsonError(
        'platform_token_invalid',
        'The hosting platform rejected this API token. Reconnect the platform in Settings.',
        401,
        { 'x-cms-platform-token-invalid': '1' },
      );
    }
    if (error.status === 404) {
      return jsonError('not_found', 'Not found on the hosting platform', 404);
    }
    if (error.status === 400) {
      return jsonError(
        'platform_bad_request',
        error.detail ?? 'The hosting platform rejected the request',
        400,
      );
    }
    return jsonError(
      'platform_error',
      `Hosting platform error (HTTP ${error.status})`,
      502,
    );
  }
  console.error(
    'Unexpected deploy service error:',
    error instanceof Error ? error.message : error,
  );
  return jsonError(fallback.code, fallback.message, fallback.status);
}
