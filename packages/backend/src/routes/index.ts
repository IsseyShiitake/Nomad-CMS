/**
 * API router.
 *
 * Top-level route dispatcher for the Worker's /api/* routes.
 * Each route module is responsible for its own path segment and
 * is registered here so the router stays a simple lookup table.
 *
 * Placeholder routes respond with "not implemented" until their
 * milestones arrive. The routing structure is established now so
 * the API surface is stable.
 */

import type { Env } from '../env';
import { jsonError, json, preflightResponse, finalizeResponse, layerCors, readSessionToken, csrfViolation } from '../core/http';
import { SessionManager, resolveEncryptionKey } from '../services/auth';
import { authRoutes } from './auth';
import { repositoryRoutes } from './repositories';
import { previewRoutes } from './preview';
import { clientsRoutes } from './clients';
import { deployRoutes } from './deploy';
import { reviewRoutes } from './review';

export interface RouteContext {
  env: Env;
}

/**
 * Purges the session behind a 401 carrying the x-cms-github-token-invalid
 * marker: the GitHub token backing the session is invalid or expired (e.g.
 * the user revoked the OAuth app). Purging means the next /session returns
 * null and the frontend shows the sign-in screen, rather than retrying with
 * a dead token. Unauthenticated/forged-cookie 401s do NOT trigger a
 * (billed) KV delete — the marker is set only by mapGitHubError for a
 * genuine upstream token rejection. Applied to every route family (audit
 * 2026-11-15: it previously ran for the repositories routes only, letting
 * dead-token sessions linger via deploy/review routes).
 */
async function purgeIfTokenInvalid(request: Request, env: Env, response: Response): Promise<Response> {
  if (response.status === 401 && response.headers.get('x-cms-github-token-invalid') === '1') {
    const token = readSessionToken(request);
    if (token) {
      await new SessionManager(env.SESSION_KV, await resolveEncryptionKey(env))
        .deleteSession(token)
        .catch(() => {});
    }
  }
  return response;
}

/** Dispatches an /api request to the matching route module. */
export async function handleApiRequest(
  path: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const ctx: RouteContext = { env };
  if (request.method === 'OPTIONS') {
    return preflightResponse(env, request);
  }

  const csrf = csrfViolation(request, env);
  if (csrf) {
    return csrf;
  }

  if (path === '/api/health') {
    return finalizeResponse(env, request, json({ status: 'ok' }));
  }

  if (path.startsWith('/api/auth')) {
    return finalizeResponse(env, request, await authRoutes.handle(path.replace('/api/auth', ''), request, ctx));
  }

  if (path.startsWith('/api/preview')) {
    // Deliberately NOT finalizeResponse'd: the shared SECURITY_HEADERS carry
    // X-Frame-Options: DENY + a frame-ancestors 'none' CSP, which would
    // forbid the very iframe this endpoint serves. previewRoutes sets its
    // own framing-capable headers; only the CORS grant is layered on top
    // (split-domain deployments preflight this route like any other).
    return layerCors(env, request, await purgeIfTokenInvalid(request, env, await previewRoutes.handle(path.replace('/api/preview', ''), request, ctx)));
  }

  if (path.startsWith('/api/repositories')) {
    return finalizeResponse(
      env,
      request,
      await purgeIfTokenInvalid(
        request,
        env,
        await repositoryRoutes.handle(path.replace('/api/repositories', ''), request, ctx),
      ),
    );
  }

  if (path.startsWith('/api/clients')) {
    return finalizeResponse(
      env,
      request,
      await purgeIfTokenInvalid(request, env, await clientsRoutes.handle(path.replace('/api/clients', ''), request, ctx)),
    );
  }

  if (path.startsWith('/api/review')) {
    return finalizeResponse(
      env,
      request,
      await purgeIfTokenInvalid(request, env, await reviewRoutes.handle(path.replace('/api/review', ''), request, ctx)),
    );
  }

  if (path.startsWith('/api/deploy')) {
    return finalizeResponse(
      env,
      request,
      await purgeIfTokenInvalid(request, env, await deployRoutes.handle(path.replace('/api/deploy', ''), request, ctx)),
    );
  }

  return finalizeResponse(env, request, jsonError('not_found', 'Route not found', 404));
}