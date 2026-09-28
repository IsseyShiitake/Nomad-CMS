/**
 * OAuth refresh wiring for platform connections.
 *
 * Wraps every platform-API use of a stored connection so OAuth connections
 * keep themselves alive: an expired access token is refreshed before the
 * call, and a mid-call 401/403 (expiry raced the call) is retried once with
 * a fresh token before the connection is marked invalid. Pasted-token
 * connections (`source` unset/'token', or no stored refresh token) never
 * take these paths — they behave exactly as before.
 *
 * Refresh results are persisted through the connection store, so a later
 * request or a new Worker instance picks up the new tokens without another
 * refresh round-trip.
 */

import { refreshPlatformToken } from '../auth/platformOauth';
import type { Env } from '../../env';
import { PlatformError } from './http';
import { CloudflarePagesClient } from './cloudflare';
import { VercelClient } from './vercel';
import type { ConnectionRecord, ConnectionStore } from './connections';

/** Client pair built for one call — one field is always set. */
export interface PlatformClients {
  cloudflare?: CloudflarePagesClient;
  vercel?: VercelClient;
}

/** True when a connection can refresh an OAuth access token. */
export function canRefresh(record: ConnectionRecord): boolean {
  return record.source === 'oauth' && typeof record.refreshToken === 'string' && record.refreshToken !== '';
}

/**
 * Refreshes a connection's access token and persists the new pair.
 *
 * Returns the updated record (token rotated, expiry advanced) or null when
 * the platform did not issue a new access token — the caller then treats
 * the connection as expired.
 */
export async function refreshConnection(
  env: Env,
  store: ConnectionStore,
  record: ConnectionRecord,
): Promise<ConnectionRecord | null> {
  if (!canRefresh(record)) return null;
  const clientSecret =
    record.platform === 'cloudflare' ? env.CLOUDFLARE_OAUTH_CLIENT_SECRET : env.VERCEL_OAUTH_CLIENT_SECRET;
  const platform = record.platform;
  const tokens = await refreshPlatformToken(
    platform,
    {
      clientId:
        platform === 'cloudflare' ? env.CLOUDFLARE_OAUTH_CLIENT_ID : env.VERCEL_OAUTH_CLIENT_ID,
      clientSecret: clientSecret ?? '',
      redirectUri: '',
    },
    record.refreshToken!,
  );
  // The platform answered but issued no access token (e.g. refresh token
  // revoked server-side) — surface as "cannot refresh" so callers keep the
  // original 401 semantics (connection marked invalid in Settings).
  if (!tokens) return null;
  const updated: ConnectionRecord = {
    ...record,
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt:
      tokens.expiresIn !== null
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : null,
  };
  await store.put(updated);
  return updated;
}

/**
 * Runs a platform-API call for one connection with OAuth token refresh.
 *
 * `run` receives the client built from the (possibly refreshed) record.
 * When the call rejects with a PlatformError 401/403 and the connection is
 * refreshable, the token is refreshed and the call retried exactly once;
 * the retry's result (or error) is what the caller sees. Every other error
 * propagates unchanged.
 */
export async function runWithConnection<T>(
  env: Env,
  store: ConnectionStore,
  record: ConnectionRecord,
  run: (clients: PlatformClients) => Promise<T>,
): Promise<T> {
  // Proactive refresh when the stored expiry has passed — avoids a wasted
  // upstream call that would only 401. Connections without a known expiry
  // (pasted tokens, platforms that do not report expires_in) go straight
  // to the call and rely on the retry path if it 401s.
  let current = record;
  if (
    canRefresh(record) &&
    record.tokenExpiresAt &&
    Date.parse(record.tokenExpiresAt) < Date.now()
  ) {
    const refreshed = await refreshConnection(env, store, current).catch(() => null);
    if (refreshed) current = refreshed;
  }

  const clientFor = (source: ConnectionRecord): PlatformClients =>
    source.platform === 'cloudflare'
      ? { cloudflare: new CloudflarePagesClient(source.token, source.accountId ?? '') }
      : { vercel: new VercelClient(source.token, source.accountId) };

  try {
    return await run(clientFor(current));
  } catch (error) {
    const refreshable =
      canRefresh(current) && error instanceof PlatformError && (error.status === 401 || error.status === 403);
    if (!refreshable) throw error;
    // The expiry raced the call: refresh and retry once. A refresh failure
    // here surfaces the ORIGINAL 401 so the existing tokenInvalid marking
    // and error mapping in the routes keep working unchanged.
    const refreshed = await refreshConnection(env, store, current).catch(() => null);
    if (!refreshed) throw error;
    return run(clientFor(refreshed));
  }
}
