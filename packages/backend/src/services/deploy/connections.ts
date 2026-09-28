/**
 * Hosting-platform connection store.
 *
 * Persists per-administrator Cloudflare/Vercel credentials in the Worker's
 * KV namespace (prefix `deploy:`). Platform API tokens are AES-GCM
 * encrypted at rest with the same key and scheme as session GitHub tokens,
 * so namespace read access alone never exposes them. Records are keyed by
 * the admin's GitHub login: each administrator connects their own platform
 * accounts, and publishing rides the connection of the admin whose repo
 * link is being used.
 */

import type { DeployConnection, DeployPlatform } from '@cms/shared';
import { decryptSecret, encryptSecret, importAesKey } from '../auth/crypto';

/** KV key prefix for platform connections. */
const PREFIX = 'deploy:';

/** A stored platform connection record. */
export interface ConnectionRecord {
  platform: DeployPlatform;
  /** Admin GitHub login that owns the connection. */
  owner: string;
  /** Platform API token, AES-GCM encrypted (base64 of iv||ciphertext). */
  token: string;
  /**
   * OAuth refresh token, AES-GCM encrypted. Null for pasted-token
   * connections and when the platform issued no refresh token.
   */
  refreshToken?: string | null;
  /** How the connection was established: a pasted API token or an OAuth login. */
  source?: 'token' | 'oauth';
  /** ISO timestamp when the OAuth access token expires, when known. */
  tokenExpiresAt?: string | null;
  /** Cloudflare account id, or Vercel team id, or null. */
  accountId: string | null;
  /** Account/team display name resolved at connect time. */
  accountName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Set when the last API call failed with 401/403 — surfaced in the UI. */
  tokenInvalid: boolean;
}

/** KV-backed connection store with at-rest token encryption. */
export class ConnectionStore {
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

  /** KV key for one admin's connection to one platform. */
  private key(owner: string, platform: DeployPlatform): string {
    return `${PREFIX}${owner}:${platform}`;
  }

  /** Stores (or replaces) a connection, encrypting the token. */
  async put(record: Omit<ConnectionRecord, 'token'> & { token: string }): Promise<void> {
    await this.kv.put(
      this.key(record.owner, record.platform),
      JSON.stringify({
        ...record,
        token: await encryptSecret(await this.getKey(), record.token),
        // Encrypt the refresh token when present; never store it in the clear.
        ...(record.refreshToken
          ? { refreshToken: await encryptSecret(await this.getKey(), record.refreshToken) }
          : {}),
      }),
    );
  }

  /** Fetches a connection, decrypting its token. Null when absent/corrupt. */
  async get(owner: string, platform: DeployPlatform): Promise<ConnectionRecord | null> {
    const value = await this.kv.get(this.key(owner, platform));
    if (!value) return null;
    let parsed: ConnectionRecord;
    try {
      parsed = JSON.parse(value) as ConnectionRecord;
    } catch {
      return null;
    }
    try {
      parsed.token = await decryptSecret(await this.getKey(), parsed.token);
      if (parsed.refreshToken) {
        parsed.refreshToken = await decryptSecret(await this.getKey(), parsed.refreshToken);
      }
    } catch {
      // Tampered ciphertext or rotated key — treat as no connection rather
      // than surfacing a partial record.
      return null;
    }
    return parsed;
  }

  /** Deletes a connection. */
  async delete(owner: string, platform: DeployPlatform): Promise<boolean> {
    const existing = await this.get(owner, platform);
    if (!existing) return false;
    await this.kv.delete(this.key(owner, platform));
    return true;
  }

  /** Marks the last-use timestamp and token-validity flag. */
  async touch(
    owner: string,
    platform: DeployPlatform,
    patch: { lastUsedAt?: string; tokenInvalid?: boolean },
  ): Promise<void> {
    const existing = await this.get(owner, platform);
    if (!existing) return;
    await this.put({
      ...existing,
      ...('lastUsedAt' in patch ? { lastUsedAt: patch.lastUsedAt! } : {}),
      ...('tokenInvalid' in patch ? { tokenInvalid: patch.tokenInvalid! } : {}),
    });
  }

  /** Strips the secret for API responses. */
  toConnection(record: ConnectionRecord): DeployConnection {
    return {
      platform: record.platform,
      accountName: record.accountName,
      accountId: record.accountId,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      tokenInvalid: record.tokenInvalid,
      source: record.source,
      tokenExpiresAt: record.tokenExpiresAt ?? null,
    };
  }
}
