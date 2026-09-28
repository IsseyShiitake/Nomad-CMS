/**
 * Platform OAuth service.
 *
 * "Log in with Cloudflare / Log in with Vercel" for the hosting-platform
 * connection card: builds the platform's authorization URL, exchanges the
 * returned code for platform tokens, refreshes them, and resolves the
 * connected account's identity — all server-side, so platform client secrets
 * and tokens never reach the frontend.
 *
 * Platform specifics (verified against their docs, 2026-09-10):
 *  - Cloudflare (developers.cloudflare.com/fundamentals/oauth/):
 *      authorize https://dash.cloudflare.com/oauth2/auth
 *      token      https://dash.cloudflare.com/oauth2/token
 *      userinfo   https://dash.cloudflare.com/oauth2/userinfo
 *      revoke     https://dash.cloudflare.com/oauth2/revoke
 *      Authorization Code only; confidential client via client_secret_post;
 *      refresh tokens (offline_access); scopes are dot-delimited API-token
 *      permission ids (account.read, pages.read, pages.write).
 *  - Vercel "Sign in with Vercel" (vercel.com/docs/sign-in-with-vercel/):
 *      authorize https://vercel.com/oauth/authorize
 *      token      https://api.vercel.com/login/oauth/token
 *      userinfo   https://api.vercel.com/login/oauth/userinfo
 *      PKCE S256 MANDATORY (code_challenge + code_challenge_method=S256);
 *      scopes openid profile offline_access; access tokens are vca_…, refresh
 *      tokens vcr_…. NOTE: API permissions (project listing / deployments via
 *      OAuth tokens) are in private beta — the token is stored now so the
 *      connection goes live when Vercel GA's it.
 *
 * SECURITY: every token response stays in the Worker; only the connection
 * record's non-secret fields are ever returned to the frontend.
 */

import type { DeployPlatform } from '@cms/shared';

/** Upper bound on platform OAuth endpoint latency before aborting. */
const OAUTH_TIMEOUT_MS = 30_000;

/** Base64url-encodes bytes without padding (RFC 7636 alphabet). */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cryptographically random RFC 7636 code verifier (43–128 chars). */
export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

/** S256 PKCE challenge for a verifier (base64url(SHA256(verifier))). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Cryptographically random OAuth state parameter (64 hex chars). */
export function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-platform static OAuth configuration. */
const PLATFORM_CONFIG: Record<DeployPlatform, {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** Scopes requested at authorization (the platform filters to those the
   * client registered; Cloudflare's docs guarantee unknown scopes drop). */
  scope: string;
  /** Vercel requires PKCE for every client; Cloudflare accepts it too, so
   * both flows always run with PKCE — one code path, stronger default. */
  pkceRequired: true;
}> = {
  cloudflare: {
    authorizeUrl: 'https://dash.cloudflare.com/oauth2/auth',
    tokenUrl: 'https://dash.cloudflare.com/oauth2/token',
    userinfoUrl: 'https://dash.cloudflare.com/oauth2/userinfo',
    scope: 'openid offline_access account.read pages.read pages.write',
    pkceRequired: true,
  },
  vercel: {
    authorizeUrl: 'https://vercel.com/oauth/authorize',
    tokenUrl: 'https://api.vercel.com/login/oauth/token',
    userinfoUrl: 'https://api.vercel.com/login/oauth/userinfo',
    scope: 'openid profile offline_access',
    pkceRequired: true,
  },
};

/** The OAuth client credentials + redirect URI for one platform. */
export interface PlatformOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Resolves the configured OAuth client for a platform (null when unset). */
export function platformOAuthClient(
  env: {
    CLOUDFLARE_OAUTH_CLIENT_ID?: string;
    CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
    CLOUDFLARE_OAUTH_REDIRECT_URI?: string;
    VERCEL_OAUTH_CLIENT_ID?: string;
    VERCEL_OAUTH_CLIENT_SECRET?: string;
    VERCEL_OAUTH_REDIRECT_URI?: string;
  },
  platform: DeployPlatform,
): PlatformOAuthClient | null {
  if (platform === 'cloudflare') {
    if (!env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim()) return null;
    return {
      clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: env.CLOUDFLARE_OAUTH_REDIRECT_URI ?? '',
    };
  }
  if (!env.VERCEL_OAUTH_CLIENT_ID?.trim()) return null;
  return {
    clientId: env.VERCEL_OAUTH_CLIENT_ID,
    clientSecret: env.VERCEL_OAUTH_CLIENT_SECRET ?? '',
    redirectUri: env.VERCEL_OAUTH_REDIRECT_URI ?? '',
  };
}

/** Builds the platform authorization URL for the browser to visit. */
export function buildAuthorizeUrl(
  platform: DeployPlatform,
  client: PlatformOAuthClient,
  state: string,
  codeChallenge: string,
): string {
  const config = PLATFORM_CONFIG[platform];
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: config.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/** Tokens returned by a platform's token endpoint. */
export interface PlatformTokens {
  accessToken: string;
  /** Present when offline_access was granted (Cloudflare + Vercel). */
  refreshToken: string | null;
  /** Seconds until the access token expires, when the platform says so. */
  expiresIn: number | null;
}

/** A token-endpoint failure with the platform's HTTP status. */
export class PlatformOAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'PlatformOAuthError';
  }
}

/**
 * Exchanges an authorization code for platform tokens.
 *
 * Both platforms take a form-encoded POST; the client secret rides the form
 * (Cloudflare is registered as client_secret_post; Vercel also accepts it
 * alongside PKCE). The same PKCE verifier used for the challenge is sent.
 */
export async function exchangePlatformCode(
  platform: DeployPlatform,
  client: PlatformOAuthClient,
  code: string,
  codeVerifier: string,
): Promise<PlatformTokens> {
  const config = PLATFORM_CONFIG[platform];
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier,
  });
  if (client.clientSecret) {
    params.set('client_secret', client.clientSecret);
  }
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new PlatformOAuthError(
      response.status,
      `Platform token exchange failed (${platform}, HTTP ${response.status})`,
    );
  }
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) {
    throw new PlatformOAuthError(502, `Platform token response missing access_token (${platform})`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
  };
}

/**
 * Refreshes an access token using the stored refresh token
 * (grant_type=refresh_token, same endpoint). Returns null when the platform
 * did not issue a refresh token at connect time — the caller then treats the
 * connection as simply expired (tokenInvalid).
 */
export async function refreshPlatformToken(
  platform: DeployPlatform,
  client: PlatformOAuthClient,
  refreshToken: string,
): Promise<PlatformTokens | null> {
  const config = PLATFORM_CONFIG[platform];
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
  if (client.clientSecret) {
    params.set('client_secret', client.clientSecret);
  }
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new PlatformOAuthError(
      response.status,
      `Platform token refresh failed (${platform}, HTTP ${response.status})`,
    );
  }
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) return null;
  return {
    accessToken: data.access_token,
    // RFC: a refresh response MAY carry a new refresh token; keep the old one
    // when the platform rotates silently otherwise.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
  };
}

/** The resolved platform identity for a connection record. */
export interface PlatformIdentity {
  /** Display name for the connection badge (email, username, or account). */
  accountName: string | null;
  /** Cloudflare account id (API calls are account-scoped); null for Vercel
   * (the token's own account/team is used, exactly like pasted tokens). */
  accountId: string | null;
}

/**
 * Resolves the connected user's identity from the platform's userinfo.
 *
 * Cloudflare's userinfo carries the user + their accounts; the first (own)
 * account id becomes the connection's accountId so the existing Pages client
 * works unchanged. Vercel's userinfo is a plain OIDC payload; keep accountId
 * null — the token is already scoped to the user's account.
 */
export async function fetchPlatformIdentity(
  platform: DeployPlatform,
  accessToken: string,
): Promise<PlatformIdentity> {
  const config = PLATFORM_CONFIG[platform];
  const response = await fetch(config.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new PlatformOAuthError(
      response.status,
      `Platform userinfo failed (${platform}, HTTP ${response.status})`,
    );
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) {
    throw new PlatformOAuthError(502, `Platform userinfo was not JSON (${platform})`);
  }
  if (platform === 'cloudflare') {
    const accounts = Array.isArray(data.accounts) ? (data.accounts as Array<Record<string, unknown>>) : [];
    const first = accounts[0] ?? {};
    return {
      accountName: (typeof data.email === 'string' && data.email) || (typeof data.name === 'string' && data.name) || null,
      accountId: typeof first.id === 'string' ? first.id : null,
    };
  }
  return {
    accountName: (typeof data.name === 'string' && data.name) || (typeof data.email === 'string' && data.email) || null,
    accountId: null,
  };
}

export { PLATFORM_CONFIG };
