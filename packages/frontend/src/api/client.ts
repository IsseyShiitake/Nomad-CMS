import { config } from '@/config';
import type { ApiError, ApiErrorResponse } from '@cms/shared';

/**
 * API client for the CMS backend.
 *
 * A thin, typed wrapper around fetch. All backend communication flows through
 * this module so that error handling, credentials, and the CSRF header stay
 * in one place.
 *
 * Auth uses an HttpOnly session cookie set by the Worker; the browser sends
 * it automatically via `credentials: 'include'`, so the token is never
 * accessible to JavaScript. State-changing methods carry an X-CSRF-Token
 * header — a custom header forces a CORS preflight on cross-origin requests,
 * which is the CSRF defense for the SameSite=None production cookie.
 */

/** Error thrown when the API returns a non-2xx response. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Per-page-load CSRF token. The value is not verified by the server; its
 * presence as a custom header is what blocks cross-site forgeries (a forged
 * request from an untrusted origin cannot set a custom header without
 * passing a CORS preflight).
 */
const CSRF_TOKEN = (() => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
})();

/** Notified when a non-auth endpoint answers 401 (the session is dead).
 * The app wires this to drop its session state and show the sign-in
 * screen, instead of a hard reload that would bypass navigation guards. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Registers (or clears) the global unauthorized handler. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/** Resolves the full URL for an API path. */
function resolveUrl(path: string): string {
  const base = config.apiBaseUrl.replace(/\/$/, '');
  return `${base}${path}`;
}

/** True when the request body is FormData (browser sets the boundary). */
function isFormData(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

/** Methods that must carry the X-CSRF-Token header. */
function isStateChanging(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/**
 * Performs a request against the API.
 *
 * @param path - API path, e.g. "/api/repositories".
 * @param init - Fetch options. A JSON body is stringified automatically; a
 *   FormData body is passed through untouched.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Content-Type rides along only when there is a body to describe — a JSON
  // Content-Type on bodyless GETs would force needless CORS preflights in
  // split-domain deployments.
  if (!isFormData(init.body) && init.body != null) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (isStateChanging(method)) {
    headers.set('X-CSRF-Token', CSRF_TOKEN);
  }

  const url = resolveUrl(path);
  if (import.meta.env.DEV) {
    console.debug('[api] request issued', { method, url });
  }
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
    // A caller-provided signal wins; otherwise every request times out
    // after 30s so a hung backend surfaces as an error instead of an
    // infinite spinner.
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (import.meta.env.DEV) {
    console.debug('[api] response received', { url, status: response.status, ok: response.ok });
  }
  if (!response.ok) {
    let error: ApiError = { code: 'unknown', message: 'Request failed' };
    try {
      const body = (await response.json()) as ApiErrorResponse;
      if (body.error) {
        error = body.error;
      }
    } catch {
      // Non-JSON error body; fall back to the default error.
    }
    // A session-dead 401 on a non-auth endpoint drops the app to the
    // sign-in screen through state (a hard reload would bypass the
    // editor's unsaved-changes guard). Only the session-dead error CODE
    // triggers this: the backend also answers 401 platform_token_invalid
    // (wrong/expired hosting token) while the CMS session is healthy — and
    // a dead GitHub backing token answers plain 'unauthorized' with an
    // x-cms-github-token-invalid marker header, which MUST keep signing
    // out. /api/auth is skipped so the OAuth callback's own handling runs.
    if (response.status === 401 && error.code === 'unauthorized' && !path.startsWith('/api/auth')) {
      onUnauthorized?.();
    }
    throw new ApiClientError(response.status, error.code, error.message);
  }

  // The backend wraps every successful payload in `{ data }` (see
  // core/http.ts `json()`). Unwrap here so callers receive `T` directly.
  const body = (await response.json()) as { data?: T };
  if (!('data' in body)) {
    throw new ApiClientError(response.status, 'bad_response', 'Response was missing the data envelope');
  }
  return body.data as T;
}
