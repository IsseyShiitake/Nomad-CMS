/**
 * Seeds the LOCAL wrangler KV state with an admin session and a client
 * access record so both sign-in flows can be exercised without GitHub
 * OAuth (the dev secret is scrubbed).
 *
 * Unlike the previous version (which only wrote JSON files into a temp
 * directory), this writes real records into miniflare's KV state:
 * blob files under .wrangler/state/v3/kv/<namespace-id>/blobs/ plus rows
 * in the _mf_entries table of the namespace's sqlite database.
 *
 * Stop `npm run dev:backend` before running this script; start it again
 * after (miniflare caches state in-process and holds the sqlite file).
 *
 * Usage (from packages/backend):
 *   node scripts/seed-local.mjs                          # fake GitHub token
 *   node scripts/seed-local.mjs --reuse-session <token>  # decrypt an existing session's token
 *   GITHUB_TOKEN=ghp_... node scripts/seed-local.mjs     # explicit token
 *   CLIENT_REPO=owner/repo node scripts/seed-local.mjs   # client's locked repo
 */
import { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite landed in Node 22.5 (stable later); the root package.json
// still allows Node 20, where the import would crash obscurely. Fail with
// an actionable message instead.
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  fail(`seed-local.mjs needs Node >= 22.5 (node:sqlite); this is Node ${process.versions.node}.`);
}
const { DatabaseSync } = await import('node:sqlite');

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const KV_STATE_DIR = join(BACKEND_DIR, '.wrangler', 'state', 'v3', 'kv');
const ENTRIES_DIR = join(KV_STATE_DIR, 'miniflare-KVNamespaceObject');

const FAKE_GITHUB_TOKEN = 'ghp_local-demo-token';
const CLIENT_ID = 'acme-demo';
const CLIENT_PASSWORD = 'demo-password-1';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const subtle = webcrypto.subtle;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value) {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

/** Mirrors parseKey() in src/services/auth/crypto.ts (base64 or hex, 32 bytes). */
function parseKey(secret) {
  const trimmed = secret.trim();
  const isHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === 64;
  const raw = isHex
    ? Uint8Array.from(trimmed.match(/.{2}/g), (hex) => parseInt(hex, 16))
    : base64ToBytes(trimmed);
  if (raw.byteLength !== 32) {
    fail(`SESSION_ENCRYPTION_KEY must be 32 bytes (got ${raw.byteLength})`);
  }
  return raw;
}

async function importAesKey(secret) {
  return subtle.importKey('raw', parseKey(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Mirrors encryptSecret(): base64(iv || ciphertext), 12-byte random IV. */
async function aesEncrypt(key, plaintext) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return bytesToBase64(combined);
}

/** Mirrors decryptSecret(). */
async function aesDecrypt(key, payload) {
  const combined = base64ToBytes(payload);
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** Mirrors hashPassword(): PBKDF2-SHA256, 100k iterations, 256-bit output. */
async function pbkdf2(password, saltB64) {
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(saltB64),
      iterations: 100_000,
    },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

function randomHex(bytes) {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

// 1. SESSION_ENCRYPTION_KEY from .dev.vars.
const devVars = readFileSync(join(BACKEND_DIR, '.dev.vars'), 'utf8');
const keyMatch = devVars.match(/^SESSION_ENCRYPTION_KEY=(.+)$/m);
if (!keyMatch) fail('SESSION_ENCRYPTION_KEY not found in .dev.vars');
const aesKey = await importAesKey(keyMatch[1]);

// 2. KV namespace id from wrangler.toml. `wrangler dev` binds the
//    `preview_id` (a throwaway local namespace) rather than the production
//    `id`, so seed the preview namespace — that is the one the dev Worker
//    actually reads. Fall back to `id` when no preview namespace exists.
const wranglerToml = readFileSync(join(BACKEND_DIR, 'wrangler.toml'), 'utf8');
const kvSection = wranglerToml.slice(wranglerToml.indexOf('[[kv_namespaces]]'));
const previewMatch = kvSection.match(/^preview_id = "([^"]+)"/m);
const idMatch = kvSection.match(/^id = "([^"]+)"/m);
const namespaceId = previewMatch?.[1] ?? idMatch?.[1];
if (!namespaceId) fail('[[kv_namespaces]] id/preview_id not found in wrangler.toml');

// 3. Locate the miniflare entries database. Each namespace id gets its own
//    sqlite file, so require exactly one candidate; if several exist (e.g. a
//    stale DB from before the preview namespace was added), refuse rather
//    than guess and tell the user how to reset.
let entriesDbPath = null;
let candidates = [];
try {
  candidates = readdirSync(ENTRIES_DIR).filter((name) =>
    /^[0-9a-f]{64}\.sqlite$/.test(name),
  );
} catch {
  candidates = [];
}
if (candidates.length === 1) {
  entriesDbPath = join(ENTRIES_DIR, candidates[0]);
} else if (candidates.length > 1) {
  fail(
    `Found ${candidates.length} miniflare KV databases in ${ENTRIES_DIR}; ` +
      'cannot tell which belongs to the preview namespace. Stop the dev ' +
      'server, delete the *.sqlite files in that directory (keep ' +
      'metadata.sqlite), run `npm run dev:backend` once and stop it, then ' +
      're-run this script.',
  );
}
if (!entriesDbPath) {
  fail('Run `npm run dev:backend` once, stop it, then re-run this script');
}

// 4. Resolve the GitHub token.
let githubToken = null;
const reuseIndex = process.argv.indexOf('--reuse-session');
if (reuseIndex !== -1) {
  const token = process.argv[reuseIndex + 1];
  if (!token) fail('--reuse-session requires a session token argument');
  const db = new DatabaseSync(entriesDbPath, { readOnly: true });
  const row = db.prepare('SELECT blob_id FROM _mf_entries WHERE key = ?').get(`session:${token}`);
  db.close();
  if (!row) fail(`Session ${token} not found in local KV state`);
  const blobPath = join(KV_STATE_DIR, namespaceId, 'blobs', row.blob_id);
  let record;
  try {
    record = JSON.parse(readFileSync(blobPath, 'utf8'));
  } catch {
    fail(`Blob for session ${token} is missing or unreadable at ${blobPath}`);
  }
  try {
    githubToken = await aesDecrypt(aesKey, record.githubToken);
  } catch {
    fail('Could not decrypt the session GitHub token — wrong SESSION_ENCRYPTION_KEY?');
  }
} else if (process.env.GITHUB_TOKEN) {
  githubToken = process.env.GITHUB_TOKEN;
} else {
  githubToken = FAKE_GITHUB_TOKEN;
  console.warn(
    'WARNING: no GitHub token available (--reuse-session or GITHUB_TOKEN); ' +
      'using a fake token — repository API calls will 401.',
  );
}

// Profile: real token → fetch the GitHub user; otherwise a static fallback.
let profile = { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: null };
if (githubToken !== FAKE_GITHUB_TOKEN) {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'cms-seed-local' },
    });
    if (response.ok) {
      const user = await response.json();
      profile = { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url };
    } else {
      console.warn(`WARNING: GitHub /user returned ${response.status}; using the octocat profile.`);
    }
  } catch (error) {
    console.warn(`WARNING: GitHub /user fetch failed (${error.message}); using the octocat profile.`);
  }
}

// 5. Build the records.
const now = new Date().toISOString();
const encryptedToken = await aesEncrypt(aesKey, githubToken);

const sessionToken = randomHex(32);
const sessionRecord = {
  githubToken: encryptedToken,
  user: profile,
  createdAt: now,
  lastRefreshedAt: now,
  kind: 'admin',
  repoLock: null,
};

const clientRepo = process.env.CLIENT_REPO || 'octocat/site';
const [repoOwner, repoName] = clientRepo.split('/');
if (!repoOwner || !repoName) fail(`CLIENT_REPO must look like owner/repo (got "${clientRepo}")`);

const salt = bytesToBase64(webcrypto.getRandomValues(new Uint8Array(16)));
const clientRecord = {
  clientId: CLIENT_ID,
  label: 'ACME Demo',
  repo: { owner: repoOwner, repo: repoName },
  createdBy: profile.login,
  passwordHash: await pbkdf2(CLIENT_PASSWORD, salt),
  salt,
  githubToken: encryptedToken,
  createdAt: now,
  lastUsedAt: null,
  revoked: false,
  failedAttempts: 0,
  lockedUntil: null,
};

// 6. Write blobs + rows into the miniflare KV state.
const blobsDir = join(KV_STATE_DIR, namespaceId, 'blobs');
mkdirSync(blobsDir, { recursive: true });

const db = new DatabaseSync(entriesDbPath);
const insert = db.prepare(
  'INSERT OR REPLACE INTO _mf_entries (key, blob_id, expiration, metadata) VALUES (?, ?, ?, NULL)',
);

function putEntry(key, value, expiration) {
  const blobId = `seed-${key.replace(/[^a-zA-Z0-9:-]/g, '_')}-${Date.now()}-${randomHex(4)}`;
  writeFileSync(join(blobsDir, blobId), value);
  insert.run(key, blobId, expiration);
}

putEntry(`session:${sessionToken}`, JSON.stringify(sessionRecord), Date.now() + SESSION_TTL_MS);
putEntry(`client:${CLIENT_ID}`, JSON.stringify(clientRecord), null);
db.close();

// 7. Report.
console.log('Stop `npm run dev:backend` before running this script; start it again after.');
console.log(`SESSION_TOKEN=${sessionToken}`);
console.log(`CLIENT_ID=${CLIENT_ID}`);
console.log(`CLIENT_PASSWORD=${CLIENT_PASSWORD}`);
console.log(`CLIENT_REPO=${clientRepo}`);
