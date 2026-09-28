/**
 * Tests for the client credential helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  generateClientId,
  generatePassword,
  generateSalt,
  hashPassword,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('round-trips: verify accepts the hashed password', async () => {
    const salt = generateSalt();
    const hash = await hashPassword('correct horse battery', salt);
    expect(await verifyPassword('correct horse battery', salt, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const salt = generateSalt();
    const hash = await hashPassword('correct horse battery', salt);
    expect(await verifyPassword('wrong password', salt, hash)).toBe(false);
  });

  it('produces different hashes for different salts', async () => {
    const hash1 = await hashPassword('same-password', generateSalt());
    const hash2 = await hashPassword('same-password', generateSalt());
    expect(hash1).not.toBe(hash2);
  });
});

describe('generateClientId', () => {
  it('slugs the label and appends a 4-char suffix', () => {
    const id = generateClientId('ACME Corp');
    expect(id).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(id.startsWith('acme-corp-')).toBe(true);
  });

  it('falls back to "client" for labels without usable characters', () => {
    const id = generateClientId('///');
    expect(id).toMatch(/^client-[a-z0-9]{4}$/);
  });
});

describe('generatePassword', () => {
  it('has the requested length and uses the unambiguous alphabet', () => {
    const password = generatePassword();
    expect(password).toHaveLength(14);
    expect(password).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  });
});
