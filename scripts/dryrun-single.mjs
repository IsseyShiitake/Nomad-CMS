#!/usr/bin/env node
/**
 * Scripted dry-run of the Ana path (implements.md §5b gate).
 *
 * Runs the REAL dist-single/setup.mjs against a MOCK `npx`/`wrangler`
 * toolchain, so the full interactive flow — prompts, KV creation with
 * output parsing, probe deploy + URL discovery (and its paste fallback),
 * GitHub-app handoff, client-id capture, hidden secret read piped to
 * `wrangler secret put`, toml rewriting, final deploy — is exercised end
 * to end WITHOUT touching any Cloudflare account.
 *
 * Scenarios:
 *   1. happy path (not pre-authenticated → login path exercised);
 *   2. idempotent re-run in the same folder (namespaces already exist →
 *      reused via `kv namespace list`, not duplicated);
 *   3. probe-deploy output without a parseable URL → the paste fallback;
 *   4. missing wrangler.toml → clean refusal before anything happens;
 *   5. a tampered wrangler.toml (slot line removed) → loud failure at
 *      the targeted replacement, with the earlier atomic writes intact.
 *
 * Security assertions baked into every scenario: the client secret never
 * appears in ANY file of the workspace (the mock records only its
 * SHA-256), and no wrangler.toml.tmp leftover remains.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleSrc = join(root, 'dist-single');
const SECRET = 'dryrun-secret-never-ship';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** The mock npx/wrangler stand-in (single node script on PATH). */
const MOCK_NPX = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = process.env.MOCK_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
const args = process.argv.slice(2).filter((a) => a !== '-y');
const rest = args.slice(1);
if (!/^wrangler(@|$)/.test(args[0] ?? '')) {
  console.error('mock npx: refusing to run non-wrangler command:', args[0]);
  process.exit(1);
}
const name = /^name = "(.*)"$/m.exec(readFileSync('wrangler.toml', 'utf8'))?.[1] ?? 'unknown';
const sub = rest[0] ?? '';
if (sub === 'whoami') {
  if (process.env.MOCK_ALREADY_AUTH) {
    console.log('Getting User settings...');
    console.log('👤 You are logged in with an OAuth Token, associated with the email mock@example.com!');
    process.exit(0);
  }
  console.error('wrangler whoami: You are not authenticated. Please run wrangler login.');
  process.exit(1);
}
if (sub === 'login') {
  console.log('Successfully logged in.');
  process.exit(0);
}
if (sub === 'kv' && rest[1] === 'namespace') {
  // Mirrors REAL wrangler semantics (as observed live 2026-10-06):
  // titles are used verbatim, are GLOBAL per account, and creating a
  // duplicate title fails — no --preview flag involved.
  state.namespaces = state.namespaces ?? {};
  const title = rest[2] ?? '';
  if (rest[2] === 'create') {
    const t = rest[3] ?? '';
    if (state.namespaces[t]) {
      console.error(\`The namespace title "\${t}" is already in use by another namespace. Please select a different name.\`);
      process.exit(1);
    }
    const id = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    state.namespaces[t] = id;
    state.name = name;
    save();
    console.log(\`🌀 Creating namespace with title "\${t}"\`);
    console.log('✨ Success!');
    console.log(\`{ binding = "SESSIONS", id = "\${id}" }\`);
    process.exit(0);
  }
  if (rest[2] === 'list') {
    const entries = Object.entries(state.namespaces).map(([title, id]) => ({ id, title }));
    console.log(JSON.stringify(entries));
    process.exit(0);
  }
}
if (sub === 'deploy') {
  state.deploys = (state.deploys ?? 0) + 1;
  save();
  console.log('Total Upload: 698.54 KiB / gzip: 227.11 KiB');
  console.log(\`Uploaded \${name} (0.82 sec)\`);
  if (!process.env.MOCK_DEPLOY_BAD_URL || state.deploys > 1) {
    console.log(\`  https://\${name}.mock-subdomain.workers.dev\`);
    console.log('Current Deployment ID: 00000000-0000-4000-8000-000000000000');
  }
  process.exit(0);
}
if (sub === 'secret' && rest[1] === 'put') {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    state.secretPuts = state.secretPuts ?? [];
    state.secretPuts.push({
      key: rest[2],
      sha256: createHash('sha256').update(data.replace(/\\r?\\n$/, '')).digest('hex'),
    });
    save();
    console.log(\`✨ Success! Uploaded secret \${rest[2]}\`);
    process.exit(0);
  });
  process.stdin.resume();
} else {
  console.error('mock wrangler: unsupported invocation:', rest.join(' '));
  process.exit(1);
}
`;

function prepareWorkspace(label, { withSetupOnly = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), `cms-dryrun-${label}-`));
  const bundleDir = join(workspace, 'bundle');
  const binDir = join(workspace, 'bin');
  mkdirSync(bundleDir);
  mkdirSync(binDir);
  if (withSetupOnly) {
    copyFileSync(join(bundleSrc, 'setup.mjs'), join(bundleDir, 'setup.mjs'));
  } else {
    for (const file of ['nomad-cms.worker.js', 'wrangler.toml', 'setup.mjs']) {
      copyFileSync(join(bundleSrc, file), join(bundleDir, file));
    }
  }
  writeFileSync(join(binDir, 'npx'), MOCK_NPX, 'utf8');
  chmodSync(join(binDir, 'npx'), 0o755);
  return { workspace, bundleDir, binDir, stateFile: join(workspace, 'mock-state.json') };
}

function runSetup({ bundleDir, binDir, stateFile }, answers, flags = {}, { resetState = true } = {}) {
  if (resetState) writeFileSync(stateFile, '{}', 'utf8');
  return spawnSync('node', ['setup.mjs'], {
    cwd: bundleDir,
    input: `${answers.join('\n')}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CMS_SETUP_NO_BROWSER: '1',
      MOCK_STATE: stateFile,
      ...(flags.alreadyAuth ? { MOCK_ALREADY_AUTH: '1' } : {}),
      ...(flags.badDeployUrl ? { MOCK_DEPLOY_BAD_URL: '1' } : {}),
    },
  });
}

const tomlOf = (dir) => readFileSync(join(dir, 'wrangler.toml'), 'utf8');
const slot = (toml, key) => new RegExp(`^${key} = "(.*)"$`, 'm').exec(toml)?.[1];

function filesUnder(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else acc.push(full);
  }
  return acc;
}

function assertSecretNeverOnDisk(name, workspace, result) {
  const offenders = filesUnder(workspace).filter(
    (file) => readFileSync(file).includes(SECRET),
  );
  check(name, offenders.length === 0, `secret bytes found in: ${offenders.join(', ')}`);
  const leakedToArgv = (result.args ?? []).some((arg) => String(arg).includes(SECRET));
  check(`${name} (argv)`, !leakedToArgv);
}

function report(label, result, { expected = false } = {}) {
  if (result.status === 0 || expected) return;
  console.error(`\n--- ${label}: setup exited ${result.status} — full output follows ---`);
  console.error(result.stdout);
  console.error(result.stderr);
}

function main() {
  if (!existsSync(join(bundleSrc, 'setup.mjs'))) {
    console.error('dryrun-single: dist-single/ has no setup.mjs — run `npm run build:single` first.');
    process.exit(1);
  }
  const secretSha = createHash('sha256').update(SECRET).digest('hex');

  // ── Scenario 1: happy path, not pre-authenticated (login exercised) ──
  {
    const ws = prepareWorkspace('s1');
    const result = runSetup(ws, ['cms-dryrun-a', 'ana', '', 'Ov23dryrunclient', SECRET]);
    report('S1 happy path', result);
    check('S1: setup completes (exit 0)', result.status === 0);
    check('S1: login path exercised', (result.stdout ?? '').includes('browser will open to log you into Cloudflare'));
    const toml = tomlOf(ws.bundleDir);
    check('S1: worker name written', slot(toml, 'name') === 'cms-dryrun-a');
    const id = slot(toml, 'id');
    const previewId = slot(toml, 'preview_id');
    check('S1: real-format KV ids written, and they differ', /^[0-9a-f]{32}$/.test(id ?? '') && /^[0-9a-f]{32}$/.test(previewId ?? '') && id !== previewId, `id=${id} preview=${previewId}`);
    check('S1: client id written', slot(toml, 'GITHUB_CLIENT_ID') === 'Ov23dryrunclient');
    check('S1: operator written', slot(toml, 'OPERATOR_LOGIN') === 'ana');
    const base = 'https://cms-dryrun-a.mock-subdomain.workers.dev';
    check('S1: GitHub redirect from discovered URL', slot(toml, 'GITHUB_REDIRECT_URI') === `${base}/auth/callback`);
    check('S1: Cloudflare redirect URI', slot(toml, 'CLOUDFLARE_OAUTH_REDIRECT_URI') === `${base}/auth/platform/cloudflare/callback`);
    check('S1: Vercel redirect URI', slot(toml, 'VERCEL_OAUTH_REDIRECT_URI') === `${base}/auth/platform/vercel/callback`);
    const state = JSON.parse(readFileSync(ws.stateFile, 'utf8'));
    check('S1: probe + final deploys happened', state.deploys === 2, `deploys=${state.deploys}`);
    check('S1: secret piped to wrangler secret put (sha256 match)', state.secretPuts?.length === 1 && state.secretPuts[0].key === 'GITHUB_CLIENT_SECRET' && state.secretPuts[0].sha256 === secretSha, JSON.stringify(state.secretPuts));
    assertSecretNeverOnDisk('S1: secret never on disk', ws.workspace, result);
    check('S1: no toml temp leftover', !existsSync(join(ws.bundleDir, 'wrangler.toml.tmp')));

    // ── Scenario 2: idempotent re-run in the same folder ──
    const idsBefore = { id: slot(tomlOf(ws.bundleDir), 'id'), previewId: slot(tomlOf(ws.bundleDir), 'preview_id') };
    const rerun = runSetup(ws, ['cms-dryrun-a', 'ana', '', 'Ov23dryrunclient', SECRET], {}, { resetState: false });
    report('S2 re-run', rerun);
    check('S2: re-run completes (exit 0)', rerun.status === 0);
    check('S2: namespaces reused, not duplicated', (rerun.stdout ?? '').includes('reusing existing namespace'));
    const toml2 = tomlOf(ws.bundleDir);
    check('S2: KV ids unchanged', slot(toml2, 'id') === idsBefore.id && slot(toml2, 'preview_id') === idsBefore.previewId);
    const state2 = JSON.parse(readFileSync(ws.stateFile, 'utf8'));
    check('S2: two more deploys', state2.deploys === 4, `deploys=${state2.deploys}`);
    check('S2: secret re-bound', state2.secretPuts?.length === 2);
    assertSecretNeverOnDisk('S2: secret never on disk', ws.workspace, rerun);
  }

  // ── Scenario 3: unparseable deploy output → paste fallback ──
  {
    const ws = prepareWorkspace('s3', {});
    const result = runSetup(
      ws,
      ['cms-dryrun-c', 'ana', 'https://cms-dryrun-c.pasted.example.workers.dev', '', 'Ov23dryrunclient', SECRET],
      { badDeployUrl: true },
    );
    report('S3 URL fallback', result);
    check('S3: setup completes via fallback (exit 0)', result.status === 0);
    check('S3: fallback prompt shown', (result.stdout ?? '').includes('could not read the URL'));
    const toml = tomlOf(ws.bundleDir);
    check('S3: redirects use the pasted URL', slot(toml, 'GITHUB_REDIRECT_URI') === 'https://cms-dryrun-c.pasted.example.workers.dev/auth/callback');
    assertSecretNeverOnDisk('S3: secret never on disk', ws.workspace, result);
  }

  // ── Scenario 4: bundle incomplete → clean refusal ──
  {
    const ws = prepareWorkspace('s4', { withSetupOnly: true });
    const result = runSetup(ws, []);
    report('S4 refusal', result, { expected: true });
    check('S4: refuses without wrangler.toml (non-zero exit)', result.status !== 0);
    check('S4: message names the missing file', (result.stderr ?? '').includes('wrangler.toml'));
  }

  // ── Scenario 5: tampered template → loud failure at the slot ──
  {
    const ws = prepareWorkspace('s5');
    const tomlFile = join(ws.bundleDir, 'wrangler.toml');
    writeFileSync(tomlFile, tomlOf(ws.bundleDir).replace(/^OPERATOR_LOGIN = ".*"\n/m, ''), 'utf8');
    const result = runSetup(ws, ['cms-dryrun-e', 'ana', '', 'Ov23dryrunclient', SECRET]);
    report('S5 tampered toml', result, { expected: true });
    check('S5: fails loudly (non-zero exit)', result.status !== 0);
    check('S5: failure names the slot guard', (result.stderr ?? '').includes('exactly one line matching'));
    const toml = tomlOf(ws.bundleDir);
    check('S5: earlier atomic writes intact (name + KV ids survived)', slot(toml, 'name') === 'cms-dryrun-e' && /^[0-9a-f]{32}$/.test(slot(toml, 'id') ?? ''));
    check('S5: no toml temp leftover', !existsSync(join(ws.bundleDir, 'wrangler.toml.tmp')));
    assertSecretNeverOnDisk('S5: secret never on disk', ws.workspace, result);
  }

  console.log(failures === 0 ? 'dryrun-single: ALL SCENARIOS PASSED' : `dryrun-single: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
