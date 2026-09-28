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

/** Session lifetime in seconds (7 days). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
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

  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
  ) {}

  /** Imports the AES-GCM key once and caches the promise. */
  private getKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      this.cryptoKey = importAesKey(this.encryptionKey);
    }
    return this.cryptoKey;
  }

  /** Creates an admin session and returns the opaque session token. */
  async createSession(githubToken: string, user: UserProfile): Promise<string> {
    return this.createSessionWithKind(githubToken, user, 'admin', null, null, null);
  }

  /** Creates a client session locked to one repository. */
  async createClientSession(
    githubToken: string,
    user: UserProfile,
    repoLock: RepoRef,
    connectionOwner: string | null = null,
    language: 'en' | 'fr' | null = null,
  ): Promise<string> {
    return this.createSessionWithKind(githubToken, user, 'client', repoLock, connectionOwner, language);
  }

  /** Shared session creation for both kinds. */
  private async createSessionWithKind(
    githubToken: string,
    user: UserProfile,
    kind: SessionKind,
    repoLock: RepoRef | null,
    connectionOwner: string | null,
    language: 'en' | 'fr' | null,
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
    // Sliding renewal: if the session was last refreshed more than a day ago,
    // re-write it with a fresh TTL (and a fresh ciphertext) so an actively
    // used session does not expire. Throttled to once per day to avoid a KV
    // write on every request.
    const refreshedAt = Date.parse(parsed.lastRefreshedAt ?? parsed.createdAt);
    if (Number.isNaN(refreshedAt) || Date.now() - refreshedAt > REFRESH_INTERVAL_MS) {
      const refreshed: SessionRecord = {
        githubToken: await encryptSecret(await this.getKey(), parsed.githubToken),
        user: parsed.user,
        createdAt: parsed.createdAt,
        lastRefreshedAt: new Date().toISOString(),
        kind: parsed.kind,
        repoLock: parsed.repoLock,
        connectionOwner: parsed.connectionOwner,
        language: parsed.language,
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
