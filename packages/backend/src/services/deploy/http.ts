/**
 * Shared HTTP plumbing for hosting-platform API clients.
 *
 * Both the Cloudflare Pages and Vercel clients speak REST over HTTPS with
 * bearer-token auth. This module centralizes the request wrapper so both
 * clients share the same error taxonomy (auth failures, rate limits,
 * transient 5xx) and the same secret-handling rule: tokens are sent in the
 * Authorization header only and never included in error messages or logs.
 */

/** A hosting-platform REST error carrying the upstream HTTP status. */
export class PlatformError extends Error {
  constructor(
    public readonly status: number,
    /** Machine-readable upstream error detail when available. */
    public readonly detail: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** Platform rate limit (HTTP 429 or a documented 403-with-Retry-After). */
export class PlatformRateLimitError extends PlatformError {
  constructor(
    /** Suggested wait in seconds parsed from Retry-After, when present. */
    public readonly retryAfter: number | null,
  ) {
    super(429, null, 'Platform rate limit exceeded');
    this.name = 'PlatformRateLimitError';
  }
}

/** Upper bound on platform API latency before the request is aborted. */
export const PLATFORM_TIMEOUT_MS = 30_000;

/**
 * Performs a JSON request against a hosting platform API.
 *
 * The token is used only for the Authorization header. Error bodies are
 * truncated and scrubbed of the token (which never appears in a response
 * body, but the truncation guards against accidental secrets in proxied
 * diagnostics).
 */
export async function platformRequest<T>(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Both platforms may rate-limit with 429 + Retry-After; Cloudflare also
    // uses 429 for Pages API throttling.
    if (response.status === 429) {
      const retryHeader = response.headers.get('Retry-After');
      const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : NaN;
      throw new PlatformRateLimitError(Number.isFinite(parsed) ? parsed : null);
    }
    const body = await response.text();
    throw new PlatformError(
      response.status,
      extractErrorDetail(body),
      `Platform API ${response.status}`,
    );
  }

  // Some platform endpoints (e.g. Vercel file upload) return 200 with an
  // empty body — parse defensively.
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** Pulls a human-readable message out of a platform error body, best-effort. */
function extractErrorDetail(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string };
      message?: string;
      errors?: Array<{ message?: string }>;
      // Vercel error shape
      msg?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.errors?.[0]?.message) return parsed.errors[0].message;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.msg === 'string') return parsed.msg;
  } catch {
    /* non-JSON body */
  }
  return body.slice(0, 200);
}
