/**
 * Canonical rotating GitHub OAuth grant store.
 *
 * One grant per admin login lives in KV (`github-grant:<login>`), AES-GCM
 * encrypted with the same scheme as sessions. All refreshes go through the
 * grant because GitHub refresh tokens are single-use rotating — copies in
 * multiple records would desync on the first rotation.
 */

import { decryptSecret, encryptSecret, importAesKey } from './crypto';
import type { GitHubTokenPair } from './oauth';
import { RefreshTokenRejectedError, refreshGitHubToken } from './oauth';

/** GitHub OAuth client credentials for refresh calls. */
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** Refresh this far before hard expiry (5 minutes). */
export const TOKEN_REFRESH_MARGIN_MS = 300_000;

/** KV key prefix for grant records. */
const GRANT_PREFIX = 'github-grant:';

/** Stored grant payload (tokens encrypted, expiries absolute epoch ms). */
interface StoredGrant {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
}

/** Canonical rotating grant store backed by a KV namespace. */
export class GitHubGrantStore {
  private cryptoKey: Promise<CryptoKey> | null = null;

  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
  ) {}

  private getKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      this.cryptoKey = importAesKey(this.encryptionKey);
    }
    return this.cryptoKey;
  }

  /** Loads the grant for a login, or null if missing/corrupt. */
  async load(login: string): Promise<GitHubTokenPair | null> {
    const value = await this.kv.get(`${GRANT_PREFIX}${login}`);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as StoredGrant;
      const key = await this.getKey();
      const accessToken = await decryptSecret(key, parsed.accessToken);
      const refreshToken = parsed.refreshToken
        ? await decryptSecret(key, parsed.refreshToken)
        : null;
      return {
        accessToken,
        refreshToken,
        accessExpiresAt: parsed.accessExpiresAt ?? null,
        refreshExpiresAt: parsed.refreshExpiresAt ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Persists the grant, TTL'd to its refresh expiry (min 60s) or no TTL. */
  async save(login: string, pair: GitHubTokenPair): Promise<void> {
    const key = await this.getKey();
    const stored: StoredGrant = {
      accessToken: await encryptSecret(key, pair.accessToken),
      refreshToken: pair.refreshToken ? await encryptSecret(key, pair.refreshToken) : null,
      accessExpiresAt: pair.accessExpiresAt,
      refreshExpiresAt: pair.refreshExpiresAt,
    };
    if (pair.refreshExpiresAt != null) {
      const ttl = Math.max(60, Math.ceil((pair.refreshExpiresAt - Date.now()) / 1000));
      await this.kv.put(`${GRANT_PREFIX}${login}`, JSON.stringify(stored), { expirationTtl: ttl });
    } else {
      await this.kv.put(`${GRANT_PREFIX}${login}`, JSON.stringify(stored));
    }
  }

  /** Removes the grant (dead refresh chain). */
  async remove(login: string): Promise<void> {
    await this.kv.delete(`${GRANT_PREFIX}${login}`);
  }

  /** Returns a fresh access token via the grant, refreshing if near expiry. */
  async resolveFreshAccessToken(
    login: string,
    oauth: GitHubOAuthConfig,
  ): Promise<{ accessToken: string; accessExpiresAt: number | null } | null> {
    const grant = await this.load(login);
    if (!grant) return null;
    const fresh =
      grant.accessExpiresAt == null || Date.now() < grant.accessExpiresAt - TOKEN_REFRESH_MARGIN_MS;
    if (fresh) return { accessToken: grant.accessToken, accessExpiresAt: grant.accessExpiresAt };
    if (!grant.refreshToken) return null;
    try {
      const pair = await refreshGitHubToken(oauth.clientId, oauth.clientSecret, grant.refreshToken);
      await this.save(login, pair);
      return { accessToken: pair.accessToken, accessExpiresAt: pair.accessExpiresAt };
    } catch (e) {
      const reread = await this.load(login);
      if (
        reread &&
        reread.accessToken !== grant.accessToken &&
        (reread.accessExpiresAt == null || Date.now() < reread.accessExpiresAt)
      ) {
        return { accessToken: reread.accessToken, accessExpiresAt: reread.accessExpiresAt };
      }
      if (e instanceof RefreshTokenRejectedError) {
        await this.remove(login);
        return null;
      }
      return Date.now() < (grant.accessExpiresAt ?? Infinity)
        ? { accessToken: grant.accessToken, accessExpiresAt: grant.accessExpiresAt }
        : null;
    }
  }
}
