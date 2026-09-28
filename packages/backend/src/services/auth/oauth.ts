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
}

/** Exchanges an OAuth authorization code for a GitHub token. */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri?: string,
): Promise<string> {
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

  return data.access_token;
}
