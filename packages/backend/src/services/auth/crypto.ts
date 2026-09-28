/**
 * Shared crypto helpers for at-rest encryption.
 *
 * Used by both the session store and the client access store so the
 * AES-GCM scheme (random 12-byte IV prepended to the ciphertext,
 * base64-encoded) stays identical in one place.
 */

import type { Env } from '../../env';

/** AES-GCM IV length in bytes. */
const IV_BYTES = 12;

/** Required key length in bytes (AES-256). */
const KEY_BYTES = 32;

/** Decodes a base64 string into a byte array. */
export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** Encodes a byte array into a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Parses the SESSION_ENCRYPTION_KEY secret into raw key bytes.
 *
 * Accepts either a base64 string (recommended, 32 bytes encoded) or a
 * hex string. Throws if the key is missing or not 32 bytes — fail closed.
 */
function parseKey(secret: string): Uint8Array {
  if (!secret) {
    throw new Error('SESSION_ENCRYPTION_KEY is not configured');
  }
  const trimmed = secret.trim();
  // base64 path: a valid 44-char base64 of 32 bytes, or any string with
  // characters outside the hex alphabet.
  const isHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2;
  const raw = isHex
    ? Uint8Array.from(trimmed.match(/.{2}/g)!, (hex) => parseInt(hex, 16))
    : base64ToBytes(trimmed);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(
      `SESSION_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (got ${raw.byteLength})`,
    );
  }
  return raw;
}

/** Imports the AES-GCM key from the secret. */
export function importAesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', parseKey(secret), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** KV key holding the self-provisioned session encryption key (base64). */
const BOOTSTRAP_KEY = 'bootstrap:session-key';

/**
 * Resolves the session encryption key, self-provisioning when the secret is
 * absent (implements.md §4.3 — the setup script then handles exactly one
 * secret, the GitHub one).
 *
 * Precedence: an explicitly set SESSION_ENCRYPTION_KEY secret always wins.
 * Otherwise the key stored under the KV bootstrap key is used; when that is
 * also absent, 32 random bytes are generated, stored, and used thereafter.
 *
 * Tradeoff (documented for self-hosters): the generated key lives in the
 * same KV namespace as the data it encrypts — acceptable for a single-tenant
 * Worker whose only KV reader is the Worker itself. Two concurrent
 * first-boot requests could each generate a key (last write wins in KV); the
 * loser's single request still succeeds with its local key, and every later
 * request reads the winner.
 */
export async function resolveEncryptionKey(env: Env): Promise<string> {
  if (env.SESSION_ENCRYPTION_KEY && env.SESSION_ENCRYPTION_KEY.trim()) {
    // Config change guard: when a bootstrap key was provisioned earlier and
    // a secret is configured NOW, every record encrypted under the old key
    // becomes undecryptable (sessions vanish, client logins fail closed).
    // Fail loud in the logs — the data cannot be migrated automatically.
    const stored = await env.SESSION_KV.get(BOOTSTRAP_KEY);
    if (stored && stored.trim() && stored !== env.SESSION_ENCRYPTION_KEY) {
      console.error(
        'SESSION_ENCRYPTION_KEY is set but records were previously encrypted with a self-provisioned key — existing sessions/client accesses/connections will fail to decrypt. Remove the secret (or re-create the records) to recover.',
      );
    }
    return env.SESSION_ENCRYPTION_KEY;
  }
  const stored = await env.SESSION_KV.get(BOOTSTRAP_KEY);
  if (stored && stored.trim()) {
    return stored;
  }
  const generated = bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
  await env.SESSION_KV.put(BOOTSTRAP_KEY, generated);
  return generated;
}

/** Encrypts a plaintext string as base64(iv || ciphertext). */
export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return bytesToBase64(combined);
}

/** Decrypts a base64(iv || ciphertext) value back to plaintext. */
export async function decryptSecret(key: CryptoKey, payload: string): Promise<string> {
  const combined = base64ToBytes(payload);
  const iv = combined.subarray(0, IV_BYTES);
  const ciphertext = combined.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
