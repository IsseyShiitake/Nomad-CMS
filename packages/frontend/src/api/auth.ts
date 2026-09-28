import { apiRequest } from './client';
import type {
  DeployConnection,
  DeployPlatform,
  OAuthCodeExchange,
  PlatformOAuthStatus,
  SessionInfo,
} from '@cms/shared';

/**
 * Authentication API endpoints.
 *
 * The session token lives in an HttpOnly cookie set by the Worker; the
 * frontend never reads it. These calls rely on `credentials: 'include'`
 * (set in the client) to send the cookie automatically.
 */

/** Fetches the GitHub OAuth authorization URL (with a server-issued state). */
export async function startOAuthLogin(): Promise<{ url: string }> {
  return apiRequest<{ url: string }>('/api/auth/authorize');
}

/** Exchanges an OAuth code for a session (sets the session cookie). */
export async function exchangeOAuthCode(code: string, state: string): Promise<SessionInfo> {
  const payload: OAuthCodeExchange = { code, state };
  return apiRequest<SessionInfo>('/api/auth/exchange', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Which platform OAuth logins the Worker holds client credentials for. */
export async function getPlatformOAuthStatus(): Promise<PlatformOAuthStatus[]> {
  return apiRequest<PlatformOAuthStatus[]>('/api/auth/platform/status', {});
}

/** Fetches a platform's server-built authorization URL (admin session). */
export async function startPlatformLogin(platform: DeployPlatform): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(
    `/api/auth/platform/${encodeURIComponent(platform)}/authorize`,
  );
}

/** Exchanges a platform OAuth code for a stored connection (admin session). */
export async function exchangePlatformLogin(
  platform: DeployPlatform,
  code: string,
  state: string,
): Promise<DeployConnection> {
  return apiRequest<DeployConnection>(
    `/api/auth/platform/${encodeURIComponent(platform)}/exchange`,
    {
      method: 'POST',
      body: JSON.stringify({ code, state }),
    },
  );
}

/** Fetches the current session, or null if not authenticated. */
export async function getSession(): Promise<SessionInfo | null> {
  return apiRequest<SessionInfo | null>('/api/auth/session', {});
}

/** Signs in a client with an access ID and password (sets the session cookie). */
export async function clientLogin(clientId: string, password: string): Promise<SessionInfo> {
  return apiRequest<SessionInfo>('/api/auth/client-login', {
    method: 'POST',
    body: JSON.stringify({ clientId, password }),
  });
}

/** Logs out the current session (clears the session cookie). */
export async function logout(): Promise<void> {
  await apiRequest<{ success: boolean }>('/api/auth/logout', { method: 'POST' });
}
