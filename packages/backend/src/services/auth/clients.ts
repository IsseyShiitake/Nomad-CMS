/**
 * Client access store.
 *
 * Persists client credential records in the same KV namespace as sessions
 * (prefix `client:`). Each record holds a PBKDF2 password hash and the
 * admin's GitHub token encrypted with the same AES-GCM scheme as sessions.
 * Plaintext passwords are never stored and never retrievable after create /
 * reset.
 */

import type { ClientAccess, RepoRef } from '@cms/shared';
import { decryptSecret, encryptSecret, importAesKey } from './crypto';

/** KV key prefix for client records. */
const CLIENT_PREFIX = 'client:';

/** A client access record stored in KV. */
export interface ClientRecord {
  clientId: string;
  label: string;
  repo: RepoRef;
  /** Admin login that created the access. */
  createdBy: string;
  /** PBKDF2-SHA256 hash of the password (base64). */
  passwordHash: string;
  /** PBKDF2 salt (base64). */
  salt: string;
  /** Admin's GitHub token, AES-GCM encrypted (base64 of iv||ciphertext). */
  githubToken: string;
  /** ISO timestamp. */
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /** Preferred UI language for this client ('en' | 'fr'); optional, absent on legacy records. */
  language?: 'en' | 'fr';
  /** Failed sign-in attempts since the last success / lock reset. */
  failedAttempts: number;
  /** ISO timestamp until which sign-in is blocked, or null. */
  lockedUntil: string | null;
}

/** Client access store backed by a KV namespace. */
export class ClientStore {
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

  /** Encrypts the admin's GitHub token for at-rest storage. */
  async encryptGitHubToken(plaintext: string): Promise<string> {
    return encryptSecret(await this.getKey(), plaintext);
  }

  /** Decrypts the admin's GitHub token. */
  async decryptGitHubToken(payload: string): Promise<string> {
    return decryptSecret(await this.getKey(), payload);
  }

  /** Stores a new client record. */
  async create(record: ClientRecord): Promise<void> {
    await this.kv.put(`${CLIENT_PREFIX}${record.clientId}`, JSON.stringify(record));
  }

  /** Fetches a client record, or null if missing/corrupt. */
  async get(clientId: string): Promise<ClientRecord | null> {
    const value = await this.kv.get(`${CLIENT_PREFIX}${clientId}`);
    if (!value) return null;
    try {
      return JSON.parse(value) as ClientRecord;
    } catch {
      return null;
    }
  }

  /** Lists all client records, newest first. */
  async list(): Promise<ClientRecord[]> {
    // Page through the full listing — a single kv.list call silently
    // truncates at 1000 keys. Records within one page are fetched in
    // parallel (Promise.all preserves the listing's key order).
    const records: ClientRecord[] = [];
    let cursor: string | undefined;
    do {
      const listing = await this.kv.list({ prefix: CLIENT_PREFIX, cursor });
      const page = await Promise.all(
        listing.keys.map((key) => this.get(key.name.slice(CLIENT_PREFIX.length))),
      );
      records.push(...page.filter((record): record is ClientRecord => record !== null));
      cursor = listing.list_complete ? undefined : listing.cursor;
    } while (cursor !== undefined);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }

  /** Merges a patch into an existing record (read-modify-write, no TTL). */
  async update(clientId: string, patch: Partial<ClientRecord>): Promise<ClientRecord | null> {
    const record = await this.get(clientId);
    if (!record) return null;
    const updated: ClientRecord = { ...record, ...patch };
    await this.kv.put(`${CLIENT_PREFIX}${clientId}`, JSON.stringify(updated));
    return updated;
  }

  /** Deletes a client record. */
  async delete(clientId: string): Promise<void> {
    await this.kv.delete(`${CLIENT_PREFIX}${clientId}`);
  }

  /** Strips secrets from a record for API responses. */
  toAccess(record: ClientRecord): ClientAccess {
    return {
      clientId: record.clientId,
      label: record.label,
      repo: record.repo,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      revoked: record.revoked,
      language: record.language,
    };
  }
}
