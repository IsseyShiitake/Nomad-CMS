/**
 * OAuth code exchange with GitHub.
 *
 * The Worker exchanges the authorization code for a GitHub token
 * using the client secret. The frontend never sees the GitHub
 * token — it only receives an opaque session token.
 */

/** GitHub token response from the OAuth endpoint. */
interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/** A GitHub OAuth token pair with absolute expiry times (epoch ms, null = non-expiring). */
export interface GitHubTokenPair {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
}

/** Thrown when GitHub rejects the refresh token itself (revoked, lapsed, rotated). */
export class RefreshTokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshTokenRejectedError';
  }
}

/** Exchanges an OAuth authorization code for a GitHub token pair. */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri?: string,
): Promise<GitHubTokenPair> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  // GitHub requires redirect_uri at the token exchange step whenever it
  // was supplied in the original authorization request (which the CMS
  // always sends). Omitting it causes GitHub to reject the exchange with
  // redirect_uri_mismatch, seen by the caller as an authentication failure.
  if (redirectUri) {
    body.set('redirect_uri', redirectUri);
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await response.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null;

  if (!response.ok) {
    throw new Error(`GitHub OAuth failed with status ${response.status}`);
  }

  if (!data?.access_token) {
    const detail = data?.error
      ? `${data.error}${data.error_description ? ` — ${data.error_description}` : ''}`
      : 'no access token in response';
    // Include GitHub's specific error (e.g. bad_verification_code,
    // incorrect_client_credentials, redirect_uri_mismatch) so failures are
    // diagnosable from the Worker logs.
    throw new Error(`GitHub OAuth exchange failed: ${detail}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    accessExpiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null,
    refreshExpiresAt:
      typeof data.refresh_token_expires_in === 'number'
        ? Date.now() + data.refresh_token_expires_in * 1000
        : null,
  };
}

/** Refreshes a GitHub OAuth grant, returning the rotated token pair. */
export async function refreshGitHubToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<GitHubTokenPair> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await response.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null;

  if (data?.error === 'bad_refresh_token' || data?.error === 'invalid_grant') {
    throw new RefreshTokenRejectedError(data.error);
  }

  if (!response.ok) {
    throw new Error(`GitHub OAuth refresh failed with status ${response.status}`);
  }

  if (!data?.access_token || !data?.refresh_token) {
    const detail = data?.error
      ? `${data.error}${data.error_description ? ` — ${data.error_description}` : ''}`
      : 'no refresh token in response';
    throw new Error(`GitHub OAuth refresh failed: ${detail}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null,
    refreshExpiresAt:
      typeof data.refresh_token_expires_in === 'number'
        ? Date.now() + data.refresh_token_expires_in * 1000
        : null,
  };
}
