/**
 * Session manager.
 *
 * Stores GitHub OAuth tokens in Cloudflare KV, keyed by an opaque
 * session token. The session token is what the frontend receives;
 * the GitHub token itself never leaves the Worker.
 *
 * SECURITY: the GitHub token is encrypted at rest in KV with AES-GCM using
 * a key held only as a Worker secret (SESSION_ENCRYPTION_KEY). KV is
 * encrypted at rest by Cloudflare, but anyone with read access to the
 * namespace (a leaked wrangler token, a sibling Worker) could otherwise
 * recover plaintext tokens — encryption closes that gap. A random 12-byte
 * IV is prepended to each ciphertext. Sessions expire after 7 days
 * (refreshed on access for sliding renewal).
 *
 * Sessions carry a `kind` ('admin' | 'client') and an optional `repoLock`.
 * Client sessions are created from client credentials and locked to exactly
 * one repository; legacy records without these fields are treated as
 * admin sessions with no lock.
 */

import type { RepoRef, SessionKind, UserProfile } from '@cms/shared';
import { decryptSecret, encryptSecret, importAesKey } from './crypto';
import { GitHubGrantStore, TOKEN_REFRESH_MARGIN_MS } from './githubGrant';
import type { GitHubOAuthConfig } from './githubGrant';

/**
 * Session lifetime in seconds (400 days — the browser cookie ceiling,
 * RFC 6265bis). Logins must not expire under normal use: the sliding
 * renewal below re-extends the KV TTL on every active day and /session
 * re-issues the cookie with the same max-age, so an active login is
 * effectively permanent. Logout, the token-invalid purge, and the
 * revoked-access re-check still end sessions immediately.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 400;
/** Sliding renewal: re-write a session's TTL at most this often (1 day). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** KV key prefix for session records. */
const SESSION_PREFIX = 'session:';

export interface SessionRecord {
  /** GitHub access token, AES-GCM encrypted (base64 of iv||ciphertext). */
  githubToken: string;

  /** Public user profile. */
  user: UserProfile;

  /** ISO timestamp of when the session was created. */
  createdAt: string;

  /** ISO timestamp of the last TTL refresh (sliding renewal). */
  lastRefreshedAt: string;

  /** Session kind. Absent on legacy records (treated as 'admin'). */
  kind?: SessionKind;

  /** Repository lock for client sessions. Absent/null for admin. */
  repoLock?: RepoRef | null;

  /**
   * Login of the admin whose connections serve this client session (the
   * access record's createdBy). Absent on legacy client sessions and null
   * for admins.
   */
  connectionOwner?: string | null;

  /** Preferred UI language stored on the client access ('en' | 'fr'). */
  language?: 'en' | 'fr' | null;

  /** Client access id this session belongs to (null/absent for admins). */
  clientId?: string | null;

  /** Absolute epoch-ms expiry of the cached GitHub access token (null/absent = non-expiring or legacy). */
  githubTokenExpiresAt?: number | null;
}

/** Generates a cryptographically random session token. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Session manager backed by a KV namespace with at-rest encryption. */
export class SessionManager {
  private cryptoKey: Promise<CryptoKey> | null = null;
  private readonly grants: GitHubGrantStore;

  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
    private readonly oauth?: GitHubOAuthConfig,
  ) {
    this.grants = new GitHubGrantStore(kv, encryptionKey);
  }

  /** Imports the AES-GCM key once and caches the promise. */
  private getKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      this.cryptoKey = importAesKey(this.encryptionKey);
    }
    return this.cryptoKey;
  }

  /** Creates an admin session and returns the opaque session token. */
  async createSession(
    githubToken: string,
    user: UserProfile,
    githubTokenExpiresAt?: number | null,
  ): Promise<string> {
    return this.createSessionWithKind(
      githubToken,
      user,
      'admin',
      null,
      null,
      null,
      null,
      githubTokenExpiresAt ?? null,
    );
  }

  /** Creates a client session locked to one repository. */
  async createClientSession(
    githubToken: string,
    user: UserProfile,
    repoLock: RepoRef,
    connectionOwner: string | null = null,
    language: 'en' | 'fr' | null = null,
    clientId: string | null = null,
    githubTokenExpiresAt?: number | null,
  ): Promise<string> {
    return this.createSessionWithKind(
      githubToken,
      user,
      'client',
      repoLock,
      connectionOwner,
      language,
      clientId,
      githubTokenExpiresAt ?? null,
    );
  }

  /** Shared session creation for both kinds. */
  private async createSessionWithKind(
    githubToken: string,
    user: UserProfile,
    kind: SessionKind,
    repoLock: RepoRef | null,
    connectionOwner: string | null,
    language: 'en' | 'fr' | null,
    clientId: string | null = null,
    githubTokenExpiresAt: number | null = null,
  ): Promise<string> {
    const token = generateToken();
    const record: SessionRecord = {
      githubToken: await encryptSecret(await this.getKey(), githubToken),
      user,
      createdAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      kind,
      repoLock,
      connectionOwner,
      language,
      clientId,
      githubTokenExpiresAt,
    };

    await this.kv.put(`${SESSION_PREFIX}${token}`, JSON.stringify(record), {
      expirationTtl: SESSION_TTL_SECONDS,
    });

    return token;
  }

  /** Looks up a session by token. Returns null if missing/expired. */
  async getSession(token: string): Promise<SessionRecord | null> {
    const value = await this.kv.get(`${SESSION_PREFIX}${token}`);
    if (!value) {
      return null;
    }
    let parsed: SessionRecord;
    try {
      parsed = JSON.parse(value) as SessionRecord;
    } catch {
      // Corrupt or legacy record — treat as no session.
      return null;
    }
    try {
      parsed.githubToken = await decryptSecret(await this.getKey(), parsed.githubToken);
    } catch {
      // Wrong key or tampered ciphertext — treat as no session rather than
      // surfacing a partial record.
      return null;
    }
    let rotated = false;
    if (
      this.oauth &&
      parsed.githubTokenExpiresAt != null &&
      Date.now() >= parsed.githubTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS
    ) {
      const grantLogin =
        (parsed.kind ?? 'admin') === 'client' ? parsed.connectionOwner : parsed.user.login;
      if (grantLogin) {
        const fresh = await this.grants.resolveFreshAccessToken(grantLogin, this.oauth);
        if (fresh) {
          // Count only a token that actually changed as a rotation: the
          // cached-token fallbacks (transient outage inside the margin)
          // return the same token, and rewriting the session KV on every
          // request until hard expiry would defeat the KV write discipline.
          rotated = fresh.accessToken !== parsed.githubToken;
          parsed.githubToken = fresh.accessToken;
          parsed.githubTokenExpiresAt = fresh.accessExpiresAt;
        } else if (Date.now() >= parsed.githubTokenExpiresAt) return null;
      }
    }
    // Sliding renewal: if the session was last refreshed more than a day ago,
    // re-write it with a fresh TTL (and a fresh ciphertext) so an actively
    // used session does not expire. Throttled to once per day to avoid a KV
    // write on every request.
    const refreshedAt = Date.parse(parsed.lastRefreshedAt ?? parsed.createdAt);
    if (rotated || Number.isNaN(refreshedAt) || Date.now() - refreshedAt > REFRESH_INTERVAL_MS) {
      const refreshed: SessionRecord = {
        githubToken: await encryptSecret(await this.getKey(), parsed.githubToken),
        user: parsed.user,
        createdAt: parsed.createdAt,
        lastRefreshedAt: new Date().toISOString(),
        kind: parsed.kind,
        repoLock: parsed.repoLock,
        connectionOwner: parsed.connectionOwner,
        language: parsed.language,
        clientId: parsed.clientId,
        githubTokenExpiresAt: parsed.githubTokenExpiresAt,
      };
      await this.kv.put(`${SESSION_PREFIX}${token}`, JSON.stringify(refreshed), {
        expirationTtl: SESSION_TTL_SECONDS,
      });
    }
    return parsed;
  }

  /** Deletes a session, logging the user out. */
  async deleteSession(token: string): Promise<void> {
    await this.kv.delete(`${SESSION_PREFIX}${token}`);
  }
}
