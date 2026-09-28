/**
 * Client credential helpers.
 *
 * Passwords are hashed with PBKDF2-SHA256 (100k iterations, random 16-byte
 * salt) via WebCrypto — supported by both the Workers runtime and Node
 * (tests). Access IDs are a readable slug of the client label plus a short
 * random suffix; passwords use an unambiguous alphabet (no i/l/o/0/1).
 */

const ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

/** Lowercase alphabet without ambiguous characters (no i, l, o, 0, 1). */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Mixed-case alphabet without ambiguous characters. */
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

import { base64ToBytes, bytesToBase64 } from './crypto';

/** Generates `length` random characters from `alphabet`.
 *
 * Rejection sampling keeps the distribution uniform: a naive `byte %
 * alphabet.length` overweights the first (256 % length) characters
 * (256 % 56 = 32 for the password alphabet — ~25% bias). */
function randomChars(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i]! < limit) out += alphabet[bytes[i]! % alphabet.length];
    }
  }
  return out;
}

/** Hashes a password with PBKDF2-SHA256; returns base64 of the derived bits. */
export async function hashPassword(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(saltB64),
      iterations: ITERATIONS,
    },
    key,
    KEY_BITS,
  );
  return bytesToBase64(new Uint8Array(bits));
}

/** Generates a fresh random salt (base64). */
export function generateSalt(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** Constant-time comparison of two base64-encoded hashes. */
export async function verifyPassword(
  password: string,
  saltB64: string,
  expectedB64: string,
): Promise<boolean> {
  const actual = await hashPassword(password, saltB64);
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expectedB64);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Generates a random client password. */
export function generatePassword(length = 14): string {
  return randomChars(PW_ALPHABET, length);
}

/** Builds a readable access ID: label slug + 4 random characters. */
export function generateClientId(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return `${slug || 'client'}-${randomChars(ID_ALPHABET, 4)}`;
}
