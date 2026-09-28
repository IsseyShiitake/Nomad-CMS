/**
 * HTTP response and auth helpers.
 *
 * Small utilities for building consistent JSON responses across all API
 * routes. Every response includes security headers; credentialed
 * cross-origin responses also get CORS headers. Session authentication uses
 * an HttpOnly cookie (never readable by JS), and state-changing methods
 * require an X-CSRF-Token header — a custom header forces a CORS preflight
 * on cross-origin requests, which is the CSRF defense for the SameSite=None
 * production cookie.
 */

import type { ApiError } from '@cms/shared';
import type { Env } from '../env';

/** Security headers applied to every API response. */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

/** Name of the HttpOnly session cookie. The __Host- prefix pins the
 * browser requirements (Secure, Path=/, no Domain attribute). */
export const SESSION_COOKIE = '__Host-cms_session';

/** Methods that mutate state and therefore require an X-CSRF-Token header. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Returns true for state-changing HTTP methods. */
function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/** Sends a JSON success response. */
export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      // Authenticated payloads must never come from a shared/probe cache.
      'Cache-Control': 'no-store',
    },
  });
}

/** Sends a JSON error response. */
export function jsonError(
  code: string,
  message: string,
  status = 400,
  extra: Record<string, string> = {},
): Response {
  const error: ApiError = { code, message };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

/** Reads a named cookie from the request's Cookie header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    // Malformed percent-encoding (e.g. "%ZZ") — treat the cookie as absent
    // so authenticated routes fail with a clean 401 instead of a 500.
    return null;
  }
}

/** Reads the opaque session token from the HttpOnly session cookie. */
export function readSessionToken(request: Request): string | null {
  const value = readCookie(request, SESSION_COOKIE);
  return value || null;
}

/**
 * Builds the cookie attribute suffix from the deployment mode and CORS
 * configuration: SameSite=None only when a credentialed cross-origin
 * allowlist is actually configured (it requires Secure); otherwise Lax,
 * which keeps cross-site requests from carrying the session cookie.
 * Secure is added for https deployments regardless of the individual
 * request's scheme, so Flexible-SSL or proxied plain-http requests never
 * downgrade the flags; plain-http local development drops it (the browser
 * would reject a Secure cookie over http).
 */
function cookieAttributes(httpsDeployment: boolean, allowCrossOrigin: boolean): string {
  const sameSite = allowCrossOrigin ? 'SameSite=None' : 'SameSite=Lax';
  return httpsDeployment ? `${sameSite}; Secure` : 'SameSite=Lax';
}

/** True when a credentialed CORS allowlist is configured (split-domain). */
export function isCredentialedCorsEnabled(env: Env): boolean {
  return Boolean(env.ALLOWED_ORIGINS && env.ALLOWED_ORIGINS.trim());
}

/** Builds a Set-Cookie value for the session token (HttpOnly). */
export function sessionCookie(
  httpsDeployment: boolean,
  _request: Request,
  token: string,
  maxAge: number,
  allowCrossOrigin: boolean,
): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${cookieAttributes(httpsDeployment, allowCrossOrigin)}; Max-Age=${maxAge}`;
}

/** Builds a Set-Cookie value that clears the session cookie. */
export function clearSessionCookie(
  httpsDeployment: boolean,
  _request: Request,
  allowCrossOrigin: boolean,
): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieAttributes(httpsDeployment, allowCrossOrigin)}; Max-Age=0`;
}

/**
 * Returns CORS headers for a credentialed response.
 *
 * Reflects the request Origin only when it appears in ALLOWED_ORIGINS. When
 * ALLOWED_ORIGINS is unset, no Access-Control-Allow-Origin is emitted —
 * same-origin (dev-proxy) requests still work, but cross-origin credentialed
 * calls fail closed until the operator configures the allowlist.
 */
export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin || allowed.length === 0 || !allowed.includes(origin)) {
    return { Vary: 'Origin' };
  }
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  };
}

/** Builds the preflight (OPTIONS) response for a credentialed CORS request. */
export function preflightResponse(env: Env, request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(env, request),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * Returns a 403 response when a state-changing request lacks the X-CSRF-Token
 * header, otherwise null. Call this BEFORE dispatching so a rejected request
 * never runs the handler (no wasted GitHub calls or orphaned sessions).
 */
export function csrfViolation(request: Request, env: Env): Response | null {
  if (isStateChanging(request.method) && !request.headers.get('X-CSRF-Token')) {
    return mergeHeaders(jsonError('csrf_required', 'Missing CSRF token', 403), env, request);
  }
  return null;
}

/**
 * Finalizes a route response by layering security + CORS headers on top.
 * (CSRF is enforced earlier, before the handler runs, to avoid wasted work.)
 */
export function finalizeResponse(env: Env, request: Request, response: Response): Response {
  return mergeHeaders(response, env, request);
}

/**
 * Layers CORS headers only (no security headers) onto a response that sets
 * its own — the preview proxy deliberately replaces X-Frame-Options/CSP with
 * framing-compatible values and must not have the shared ones stamped back,
 * but split-domain consumers still need the credentialed CORS grant.
 */
export function layerCors(env: Env, request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env, request))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Clones a response with security + CORS headers layered on top. */
function mergeHeaders(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...corsHeaders(env, request) })) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
