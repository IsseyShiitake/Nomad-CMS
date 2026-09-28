/**
 * Authentication routes.
 *
 * Handles OAuth code exchange, client credential sign-in, and session
 * management. The OAuth code exchange with GitHub happens entirely on the
 * Worker — credentials never reach the frontend.
 *
 * The session token is carried in an HttpOnly cookie (never readable by JS),
 * not in localStorage or a Bearer header. The frontend therefore never sees
 * the token; the browser sends it automatically with credentialed requests.
 *
 * Endpoints:
 *   GET  /api/auth/authorize     — build the GitHub authorize URL (server-issued state)
 *   POST /api/auth/exchange      — exchange an OAuth code for a session (sets cookie)
 *   POST /api/auth/client-login  — sign in a client with access ID + password
 *   GET  /api/auth/session       — validate the session cookie
 *   POST /api/auth/logout        — invalidate the session (clears cookie)
 *
 * Platform logins (they CONNECT the signed-in admin's Cloudflare/Vercel
 * account; the admin's identity stays GitHub-backed):
 *   GET  /api/auth/platform/status                — which platform logins are configured
 *                                                  (public: configuration only — the split
 *                                                  login screen offers the buttons to
 *                                                  signed-out visitors)
 *   GET  /api/auth/platform/:platform/authorize   — server-built platform authorize URL
 *                                                  (admin session required)
 *   POST /api/auth/platform/:platform/exchange    — code → stored connection (source
 *                                                  'oauth'; admin session required)
 */

import type {
  DeployPlatform,
  PlatformOAuthStatus,
  SessionInfo,
  UserProfile,
} from '@cms/shared';
import {
  clearSessionCookie,
  isCredentialedCorsEnabled,
  json,
  jsonError,
  readSessionToken,
  sessionCookie,
} from '../core/http';
import {
  ClientStore,
  SESSION_TTL_SECONDS,
  SessionManager,
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCodeForToken,
  exchangePlatformCode,
  fetchPlatformIdentity,
  generateCodeVerifier,
  generateOAuthState,
  hashPassword,
  isOperatorLogin,
  platformOAuthClient,
  resolveEncryptionKey,
  verifyPassword,
} from '../services/auth';
import { PlatformOAuthError } from '../services/auth';
import { ConnectionStore } from '../services/deploy';
import type { ConnectionRecord } from '../services/deploy';
import { GitHubClient } from '../services/github';
import type { RouteContext } from './index';

/** Failed sign-in attempts before a client access is temporarily locked. */
const MAX_FAILED_ATTEMPTS = 5;

/** Lock duration after too many failed attempts (15 minutes). */
const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Dummy salt for the anti-enumeration hash burn on unknown client IDs
 * (base64 of 16 zero bytes, matching SALT_BYTES in services/auth/password.ts).
 */
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

/** Builds the synthetic profile a client session presents. */
function syntheticUser(label: string): UserProfile {
  return { id: 0, login: label, name: label, avatarUrl: null };
}

/** The platforms a CMS administrator can connect with an OAuth login. */
const PLATFORMS: DeployPlatform[] = ['cloudflare', 'vercel'];

/**
 * Handles /api/auth/platform/* — the Cloudflare/Vercel OAuth logins.
 *
 * Semantics: a platform login CONNECTS the platform to the signed-in admin's
 * connection record (the admin's identity stays GitHub-backed). The flow
 * mirrors the GitHub one: authorize issues a server-built URL with a
 * KV-bound state (10-minute TTL, prefix platform-oauth:); the state record
 * also carries the PKCE verifier and the initiating admin's login, so only
 * this Worker — and only the admin who started the flow — can finish the
 * exchange.
 *
 * The split login screen also offers "Continue with Cloudflare/Vercel" to
 * signed-out visitors. Because authorize/exchange need the admin session,
 * that flow signs in with GitHub first and only then starts the platform
 * authorize (the pending intent is carried client-side across the two
 * redirects). GET /platform/status is therefore public: it answers with
 * configuration state only — never any user or connection data.
 */
async function handlePlatformPath(
  path: string,
  request: Request,
  ctx: RouteContext,
  sessions: SessionManager,
): Promise<Response> {
  // Malformed %-escapes degrade to empty segments instead of a URIError.
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return '';
      }
    });
  if (segments[0] !== 'platform') {
    return jsonError('not_found', 'Auth route not found', 404);
  }

  // GET /platform/status — which platform logins the Worker has client
  // credentials for (drives the login-screen and Settings buttons'
  // visibility). Public and safe: the response is configuration state
  // only, exactly as revealing as the public GitHub authorize builder
  // above (client ids are public vars).
  if (segments.length === 2 && segments[1] === 'status') {
    if (request.method !== 'GET') {
      return jsonError('method_not_allowed', 'Platform status supports GET only', 405);
    }
    const statuses: PlatformOAuthStatus[] = PLATFORMS.map((platform) => ({
      platform,
      available: platformOAuthClient(ctx.env, platform) !== null,
    }));
    return json(statuses);
  }

  const token = readSessionToken(request);
  const session = token ? await sessions.getSession(token) : null;
  if (!session) {
    return jsonError('unauthorized', 'Not authenticated', 401);
  }
  if ((session.kind ?? 'admin') !== 'admin') {
    return jsonError('admin_only', 'Only administrators can connect hosting platforms', 403);
  }
  const login = session.user.login;

  if (segments.length !== 3) {
    return jsonError('not_found', 'Auth route not found', 404);
  }
  const platform = segments[1]!;
  if (platform !== 'cloudflare' && platform !== 'vercel') {
    return jsonError('invalid_platform', 'Platform must be "cloudflare" or "vercel"', 400);
  }
  const action = segments[2]!;

  // GET /platform/:platform/authorize — build the platform's authorize URL.
  if (action === 'authorize') {
    if (request.method !== 'GET') {
      return jsonError('method_not_allowed', 'Platform authorize supports GET only', 405);
    }
    const client = platformOAuthClient(ctx.env, platform);
    if (!client) {
      return jsonError('platform_login_unavailable', `${platform} login is not configured`, 404);
    }
    const state = generateOAuthState();
    const verifier = generateCodeVerifier();
    const challenge = await codeChallengeS256(verifier);
    await ctx.env.SESSION_KV.put(
      `platform-oauth:${platform}:${state}`,
      JSON.stringify({ verifier, owner: login }),
      { expirationTtl: 600 },
    );
    return json({ url: buildAuthorizeUrl(platform, client, state, challenge) });
  }

  // POST /platform/:platform/exchange — swap the returned code for platform
  // tokens and store them as the admin's connection (source 'oauth').
  if (action === 'exchange') {
    if (request.method !== 'POST') {
      return jsonError('method_not_allowed', 'Platform exchange supports POST only', 405);
    }
    const client = platformOAuthClient(ctx.env, platform);
    if (!client) {
      return jsonError('platform_login_unavailable', `${platform} login is not configured`, 404);
    }
    const body = (await request.json().catch(() => null)) as
      | { code?: unknown; state?: unknown }
      | null;
    const code = typeof body?.code === 'string' ? body.code : null;
    const state = typeof body?.state === 'string' ? body.state : null;
    if (!code) {
      return jsonError('invalid_code', 'Missing authorization code', 400);
    }
    if (!state) {
      return jsonError('oauth_state', 'Invalid or expired OAuth state', 400);
    }
    const stateKey = `platform-oauth:${platform}:${state}`;
    const stored = await ctx.env.SESSION_KV.get(stateKey);
    if (!stored) {
      return jsonError('oauth_state', 'Invalid or expired OAuth state', 400);
    }
    let bound: { verifier?: unknown; owner?: unknown };
    try {
      bound = JSON.parse(stored) as { verifier?: unknown; owner?: unknown };
    } catch {
      bound = {};
    }
    // Single-use and session-bound: consume the state before any platform
    // call, and refuse it when another admin's session tries to finish the
    // flow. A wrong binding reports the same generic oauth_state error so
    // which admin owns a state is not observable.
    void ctx.env.SESSION_KV.delete(stateKey);
    if (typeof bound.verifier !== 'string' || !bound.verifier || bound.owner !== login) {
      return jsonError('oauth_state', 'Invalid or expired OAuth state', 400);
    }

    const store = new ConnectionStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
    try {
      const tokens = await exchangePlatformCode(platform, client, code, bound.verifier);
      const identity = await fetchPlatformIdentity(platform, tokens.accessToken);
      // Cloudflare Pages calls are account-scoped; a userinfo without an
      // account id cannot back a usable connection.
      if (platform === 'cloudflare' && !identity.accountId) {
        throw new PlatformOAuthError(401, 'Cloudflare userinfo carried no account id');
      }
      const record: Omit<ConnectionRecord, 'token'> & { token: string } = {
        platform,
        owner: login,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        source: 'oauth',
        tokenExpiresAt:
          tokens.expiresIn !== null
            ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
            : null,
        accountId: identity.accountId,
        accountName: identity.accountName,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        tokenInvalid: false,
      };
      await store.put(record);
      // The response is built from the local record (same KV
      // read-after-write lesson as the deploy connect route); toConnection
      // strips the token and refresh token.
      return json(store.toConnection(record), 201);
    } catch (error) {
      if (error instanceof PlatformOAuthError) {
        console.error('Platform OAuth failed:', error.message);
        return jsonError('platform_exchange_failed', `Failed to authenticate with ${platform}`, 401);
      }
      throw error;
    }
  }

  return jsonError('not_found', 'Auth route not found', 404);
}

/** Route handler for /api/auth/*. */
export const authRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    const sessions = new SessionManager(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
    // Cookie flags follow the deployment mode (https redirect URI ⇒ prod),
    // not the individual request's scheme. SameSite=None is only used when
    // a credentialed cross-origin allowlist is actually configured.
    const httpsDeployment = ctx.env.GITHUB_REDIRECT_URI.startsWith('https://');
    const allowCrossOrigin = isCredentialedCorsEnabled(ctx.env);
    // GET /authorize — build the GitHub OAuth authorize URL with a fresh,
    // server-issued state stored in KV (10-minute TTL). The frontend just
    // redirects to the returned url; it never constructs OAuth URLs itself.
    if (path === '/authorize' && request.method === 'GET') {
      const state = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      await ctx.env.SESSION_KV.put(`oauth-state:${state}`, '1', { expirationTtl: 600 });
      const url =
        'https://github.com/login/oauth/authorize?' +
        new URLSearchParams({
          client_id: ctx.env.GITHUB_CLIENT_ID,
          redirect_uri: ctx.env.GITHUB_REDIRECT_URI,
          scope: 'repo',
          state,
        }).toString();
      return json({ url });
    }

    // POST /exchange — exchange an OAuth code for a session cookie.
    if (path === '/exchange' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as
        | { code?: unknown; state?: unknown }
        | null;
      const code = typeof body?.code === 'string' ? body.code : null;
      const state = typeof body?.state === 'string' ? body.state : null;

      if (!code) {
        return jsonError('invalid_code', 'Missing authorization code', 400);
      }

      // Server-side OAuth state binding: the state must have been issued by
      // GET /authorize and still be live in KV (10-minute TTL).
      if (!state) {
        return jsonError('oauth_state', 'Invalid or expired OAuth state', 400);
      }
      const storedState = await ctx.env.SESSION_KV.get(`oauth-state:${state}`);
      if (!storedState) {
        return jsonError('oauth_state', 'Invalid or expired OAuth state', 400);
      }
      // Fire-and-forget delete: the get-then-delete race window is accepted
      // (two concurrent exchanges with the same state could both pass).
      void ctx.env.SESSION_KV.delete(`oauth-state:${state}`);

      try {
        const githubToken = await exchangeCodeForToken(
          ctx.env.GITHUB_CLIENT_ID,
          ctx.env.GITHUB_CLIENT_SECRET,
          code,
          ctx.env.GITHUB_REDIRECT_URI,
        );

        const client = new GitHubClient(githubToken);
        const user = await client.getUser();

        // Operator pinning (implements.md §4): exactly one GitHub login may
        // hold the admin role. Without this check every GitHub user signing
        // into the instance would gain admin (client store, platform
        // connect). The rejected login gets NO session; the one-time OAuth
        // state was already consumed above.
        if (!(await isOperatorLogin(ctx.env, user.login))) {
          console.error('Rejected non-operator GitHub login:', user.login);
          return jsonError(
            'instance_locked',
            'This CMS instance is locked to its operator',
            403,
          );
        }

        const token = await sessions.createSession(githubToken, user);

        // Return only the public session info; the token lives in the
        // HttpOnly cookie set below and is never exposed to JS.
        const info: SessionInfo = { user, kind: 'admin', repoLock: null };
        return new Response(JSON.stringify({ data: info }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Set-Cookie': sessionCookie(httpsDeployment, request, token, SESSION_TTL_SECONDS, allowCrossOrigin),
          },
        });
      } catch (error) {
        // Log the underlying GitHub error (e.g. incorrect_client_credentials,
        // redirect_uri_mismatch, bad_verification_code) so it is visible in
        // the Worker logs instead of only a generic 401.
        console.error('OAuth exchange failed:', error instanceof Error ? error.message : error);
        return jsonError('auth_failed', 'Failed to authenticate with GitHub', 401);
      }
    }

    // POST /client-login — sign in a client with access ID + password.
    if (path === '/client-login' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        clientId?: unknown;
        password?: unknown;
      } | null;
      const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      if (!clientId || !password) {
        return jsonError('invalid_credentials', 'Access ID and password are required', 401);
      }

      const store = new ClientStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
      const record = await store.get(clientId);
      if (!record) {
        // Burn comparable PBKDF2 time so unknown IDs are indistinguishable
        // from wrong passwords by response latency (anti-enumeration).
        await hashPassword('invalid-password', DUMMY_SALT);
        return jsonError('invalid_credentials', 'Invalid access ID or password', 401);
      }

      if (record.lockedUntil && Date.parse(record.lockedUntil) > Date.now()) {
        // Locked sign-ins return the SAME generic error as wrong passwords so
        // lockout state is not observable by an attacker probing the endpoint.
        // Burn the same PBKDF2 time as the unknown-ID and wrong-password
        // paths so the locked state is not distinguishable by latency.
        await hashPassword('invalid-password', record.salt);
        return jsonError('invalid_credentials', 'Invalid access ID or password', 401);
      }

      if (record.revoked) {
        return jsonError('revoked', 'This access has been revoked', 401);
      }

      const ok = await verifyPassword(password, record.salt, record.passwordHash);
      if (!ok) {
        const failedAttempts = (record.failedAttempts ?? 0) + 1;
        const patch =
          failedAttempts >= MAX_FAILED_ATTEMPTS
            ? {
                failedAttempts: 0,
                lockedUntil: new Date(Date.now() + LOCK_DURATION_MS).toISOString(),
              }
            : { failedAttempts };
        await store.update(clientId, patch);
        return jsonError('invalid_credentials', 'Invalid access ID or password', 401);
      }

      // Success: clear the failure counters and record the use.
      await store.update(clientId, {
        failedAttempts: 0,
        lockedUntil: null,
        lastUsedAt: new Date().toISOString(),
      });

      let githubToken: string;
      try {
        githubToken = await store.decryptGitHubToken(record.githubToken);
      } catch {
        // Tampered ciphertext or rotated key — fail closed.
        return jsonError('invalid_credentials', 'Invalid access ID or password', 401);
      }

      const user = syntheticUser(record.label);
      // The session carries the creating admin's login (deploy connections
      // are keyed by it) and the access's stored language so the frontend
      // can apply the client's preference on restore.
      const token = await sessions.createClientSession(
        githubToken,
        user,
        record.repo,
        record.createdBy,
        record.language ?? null,
      );

      const info: SessionInfo = {
        user,
        kind: 'client',
        repoLock: record.repo,
        language: record.language ?? null,
      };
      return new Response(JSON.stringify({ data: info }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(httpsDeployment, request, token, SESSION_TTL_SECONDS, allowCrossOrigin),
        },
      });
    }

    // GET /session — validate the session cookie.
    if (path === '/session' && request.method === 'GET') {
      const token = readSessionToken(request);
      if (!token) {
        return json(null);
      }

      const session = await sessions.getSession(token);
      if (!session) {
        return json(null);
      }

      // Refresh the browser cookie's max-age so an active session does not
      // expire client-side while the server-side TTL is being slid.
      const info: SessionInfo = {
        user: session.user,
        kind: session.kind ?? 'admin',
        repoLock: session.repoLock ?? null,
        language: session.language ?? null,
      };
      return new Response(JSON.stringify({ data: info }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(httpsDeployment, request, token, SESSION_TTL_SECONDS, allowCrossOrigin),
        },
      });
    }

    // POST /logout — invalidate the session and clear the cookie.
    if (path === '/logout' && request.method === 'POST') {
      const token = readSessionToken(request);
      if (token) {
        await sessions.deleteSession(token);
      }
      return new Response(JSON.stringify({ data: { success: true } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': clearSessionCookie(httpsDeployment, request, allowCrossOrigin),
        },
      });
    }

    // Platform logins (Cloudflare/Vercel) — /platform/*, admin sessions only.
    if (path.startsWith('/platform')) {
      return handlePlatformPath(path, request, ctx, sessions);
    }

    return jsonError('not_found', 'Auth route not found', 404);
  },
};
