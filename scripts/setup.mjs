#!/usr/bin/env node
/**
 * Nomad CMS — interactive setup for the single-file release bundle
 * (implements.md §5b).
 *
 * Run `node setup.mjs` from the folder holding the release bundle
 * (nomad-cms.worker.js + wrangler.toml + this script). Plain Node ≥20,
 * zero npm dependencies; every Cloudflare operation goes through a
 * version-pinned `npx wrangler`.
 *
 * The flow (the "Ana path"):
 *   1. prompts for a Worker name and your GitHub username (→ the
 *      operator pin OPERATOR_LOGIN);
 *   2. `wrangler login` (skipped when already authenticated);
 *   3. creates the two KV namespaces and fills their ids into
 *      wrangler.toml (existing namespaces with matching titles are
 *      reused, so re-runs never duplicate);
 *   4. probe-deploys with placeholder vars and parses the printed
 *      workers.dev URL (asks you to paste it when parsing fails);
 *   5. prints the exact OAuth callback URL and opens GitHub's
 *      create-OAuth-App page — the one manual web step, because GitHub
 *      has no API for creating OAuth apps;
 *   6. takes the pasted client id into wrangler.toml, and the client
 *      secret via a hidden prompt piped straight into
 *      `wrangler secret put GITHUB_CLIENT_SECRET` — the secret is never
 *      echoed, never written to any file, and never passed as a process
 *      argument (which would leak through process listings);
 *   7. writes OPERATOR_LOGIN and the three redirect URIs, redeploys,
 *      checks /api/health, and prints the finished CMS URL.
 *
 * Idempotent: every wrangler.toml write is a targeted single-line
 * replacement that fails loudly when its slot is missing, and lands via
 * an atomic temp-file rename, so an interrupted run is safely re-runnable.
 * Set CMS_SETUP_NO_BROWSER=1 to print URLs instead of opening a browser
 * (headless machines, remote SSH).
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pin parsed-output stability (deploy URL / KV ids); bump deliberately. */
const WRANGLER_VERSION = '4.124.0';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(scriptDir, 'wrangler.toml');
const workerPath = join(scriptDir, 'nomad-cms.worker.js');
const OAUTH_APP_URL = 'https://github.com/settings/applications/new';

const log = (text) => console.log(text);
const fail = (message) => {
  console.error(`\nsetup: ${message}`);
  console.error('setup: nothing is half-written that a re-run cannot finish — fix the problem above and run me again.');
  process.exit(1);
};

/** Runs a command, echoing its output; returns {status, stdout, stderr}. */
function run(cmd, args, { input, interactive = false, cwd = scriptDir } = {}) {
  const exe = process.platform === 'win32' && cmd === 'npx' ? 'npx.cmd' : cmd;
  const shell = process.platform === 'win32';
  const result = spawnSync(exe, args, {
    cwd,
    shell,
    encoding: 'utf8',
    ...(interactive
      ? { stdio: 'inherit' }
      : { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input }),
  });
  if (!interactive) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

/** Runs the pinned wrangler. Interactive mode is only for `login`. */
function wrangler(args, options = {}) {
  return run('npx', ['-y', `wrangler@${WRANGLER_VERSION}`, ...args], options);
}

function openBrowser(url) {
  if (process.env.CMS_SETUP_NO_BROWSER) {
    log(`setup: open in your browser:\n  ${url}`);
    return;
  }
  const commands = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '', url]],
  };
  const [cmd, args] = commands[process.platform] ?? ['xdg-open', [url]];
  spawnSync(cmd, args, { stdio: 'ignore' });
}

/**
 * Replaces exactly one config line matched by `pattern`.
 *
 * Failing to find the slot is fatal: a wrangler.toml whose lines no
 * longer look like the shipped template must not be silently patched
 * into some other shape.
 */
function replaceSlot(toml, pattern, line) {
  const matches = toml.match(new RegExp(pattern.source, 'gm'));
  if (!matches || matches.length !== 1) {
    fail(`wrangler.toml does not contain exactly one line matching ${pattern} — it looks modified. Restore the template's original line and re-run.`);
  }
  return toml.replace(pattern, line);
}

/** Persists wrangler.toml atomically (temp file + rename). */
function writeToml(toml) {
  const tmp = `${tomlPath}.tmp`;
  writeFileSync(tmp, toml, 'utf8');
  renameSync(tmp, tomlPath);
}

/** Reads a KV namespace id from wrangler's create output (loose on purpose). */
function parseNamespaceId(output, preferPreview) {
  const preview = /preview_id = "([0-9a-fA-F]{32})"/.exec(output);
  const plain = /id = "([0-9a-fA-F]{32})"/.exec(output);
  const match = preferPreview ? (preview ?? plain) : (plain ?? preview);
  return match?.[1] ?? null;
}

/** Worker names: 1–63 chars, lowercase alphanumerics and dashes. */
function isValidWorkerName(name) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

/** GitHub logins: alphanumeric and single dashes, ≤ 39 chars. */
function isValidGithubLogin(login) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login);
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    fail(`this script needs Node.js 20 or newer (you are running ${process.versions.node}).`);
  }
  if (!existsSync(workerPath) || !existsSync(tomlPath)) {
    fail('run me from the release bundle folder — nomad-cms.worker.js and wrangler.toml must sit beside setup.mjs.');
  }

  log('Nomad CMS setup');
  log('This deploys your own single-file Worker on your Cloudflare account.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * Buffers input lines so nothing is ever dropped. readline emits every
   * parsed line synchronously from one chunk — with piped input (a user
   * answering via stdin, or automated runs) several lines arrive before
   * the next rl.question is registered, and rl.question alone would
   * silently discard them. Every line is queued here instead.
   */
  const queuedLines = [];
  const lineWaiters = [];
  rl.on('line', (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else queuedLines.push(line);
  });
  rl.on('close', () => {
    for (const waiter of lineWaiters.splice(0)) waiter(undefined);
  });
  const nextLine = () =>
    queuedLines.length > 0
      ? Promise.resolve(queuedLines.shift())
      : new Promise((resolve) => lineWaiters.push(resolve));

  const question = async (prompt) => {
    process.stdout.write(prompt);
    const line = await nextLine();
    if (line === undefined) fail('input closed — no more answers on stdin. Run me again in an interactive terminal.');
    return line.trim();
  };
  const ask = async (prompt, validate, fallback) => {
    for (;;) {
      const answer = await question(prompt);
      const value = answer || fallback;
      if (validate(value)) return value;
      log(`setup: "${value}" is not valid here — try again.`);
    }
  };

  /**
   * Hidden-input question. Readline echoes typed characters through
   * rl.output; while the secret is being typed, every non-newline write
   * is swapped for a "*". The value itself never leaves this process
   * except through the child stdin pipe to `wrangler secret put`.
   */
  const askSecret = async (prompt) => {
    const stdout = rl.output;
    const originalWrite = stdout.write;
    let muting = false;
    stdout.write = function mutedWrite(chunk, encoding, callback) {
      if (muting && !/[\r\n]/.test(String(chunk))) {
        return originalWrite.call(stdout, '*', encoding, callback);
      }
      return originalWrite.call(stdout, chunk, encoding, callback);
    };
    process.stdout.write(prompt);
    muting = true;
    const line = await nextLine();
    muting = false;
    stdout.write = originalWrite;
    process.stdout.write('\n');
    if (line === undefined) fail('input closed — no more answers on stdin. Run me again in an interactive terminal.');
    return line.trim();
  };

  // 1 — identity of the deployment and its operator.
  const workerName = await ask(
    'Worker name (lowercase letters, digits, dashes — must not match an existing Worker on your account) [nomad-cms]: ',
    isValidWorkerName,
    'nomad-cms',
  );
  const operatorLogin = await ask(
    'Your GitHub username (becomes the sole admin login of this instance): ',
    isValidGithubLogin,
  );

  // Persist the Worker name before anything else: wrangler derives the KV
  // namespace titles from the toml's worker name, so the chosen name must
  // be in place before namespaces are created (and before re-runs look
  // them up by title).
  {
    let toml = readFileSync(tomlPath, 'utf8');
    toml = replaceSlot(toml, /^name = ".*"$/m, `name = "${workerName}"`);
    writeToml(toml);
  }

  // 2 — Cloudflare authentication.
  log('\nsetup: checking Cloudflare authentication…');
  const whoami = wrangler(['whoami']);
  if (whoami.status === 0) {
    log('setup: already authenticated with Cloudflare.');
  } else {
    log('setup: a browser will open to log you into Cloudflare…');
    const login = wrangler(['login'], { interactive: true });
    if (login.status !== 0) fail('wrangler login did not complete.');
  }

  // 3 — KV namespaces (create, or reuse on re-runs).
  // Namespace titles are GLOBAL per account and are used verbatim by
  // wrangler (no automatic worker prefix) — so the name must embed the
  // worker name to avoid colliding with pre-existing namespaces
  // ("SESSIONS" is taken on most long-lived accounts) and with a second
  // instance's namespaces. Two explicitly-titled namespaces instead of
  // the `--preview` flag, whose title mangling is wrangler-version
  // dependent; the second one fills the toml's preview_id slot.
  const namespaceFor = async (suffix) => {
    const title = `${workerName}-SESSIONS${suffix}`;
    const created = wrangler(['kv', 'namespace', 'create', title]);
    const id = parseNamespaceId(created.stdout, false);
    if (id) return id;
    // Not created — usually "already exists" on a re-run: look it up.
    const listed = wrangler(['kv', 'namespace', 'list']);
    let namespaces = [];
    try {
      namespaces = JSON.parse(listed.stdout);
    } catch {
      /* handled below */
    }
    const existing = namespaces.find((entry) => entry.title === title);
    if (existing?.id) {
      log(`setup: reusing existing namespace "${existing.title}".`);
      return existing.id;
    }
    fail(
      `could not ${created.status === 0 ? 'parse the id from' : 'create'} the ${title} namespace — run \`npx wrangler kv namespace create ${title}\` yourself, then re-run me.`,
    );
  };
  log('\nsetup: creating KV namespaces…');
  const kvId = await namespaceFor('');
  const kvPreviewId = await namespaceFor('-preview');
  if (kvId === kvPreviewId) fail('the two KV namespace ids are identical — refusing to write them.');

  let toml = readFileSync(tomlPath, 'utf8');
  toml = replaceSlot(toml, /^id = ".*"$/m, `id = "${kvId}"`);
  toml = replaceSlot(toml, /^preview_id = ".*"$/m, `preview_id = "${kvPreviewId}"`);
  writeToml(toml);
  log('setup: wrangler.toml updated (Worker name, KV ids).');

  // 4 — probe deploy: discovers the workers.dev URL before any secrets.
  log('\nsetup: probe-deploying to discover your Worker URL (vars are still placeholders)…');
  const probe = wrangler(['deploy']);
  if (probe.status !== 0) fail('probe deploy failed (see wrangler output above).');
  let workerUrl = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev/i.exec(
    `${probe.stdout}\n${probe.stderr}`,
  )?.[0];
  if (!workerUrl) {
    log('setup: could not read the URL from wrangler\u2019s output.');
    workerUrl = await ask(
      'Paste your Worker URL (https://<name>.<subdomain>.workers.dev): ',
      (value) => /^https:\/\/[^\s/]+$/i.test(value),
    );
  }
  const callbackUrl = `${workerUrl}/auth/callback`;
  log(`setup: your Worker URL is ${workerUrl}`);

  // 5 — the one manual web step: GitHub OAuth app creation.
  log('\nsetup: now create the GitHub OAuth app — the only step a browser must do');
  log('(GitHub exposes no API for creating OAuth apps).');
  log('\n  Application name : anything you like (e.g. "Nomad CMS")');
  log(`  Homepage URL     : ${workerUrl}`);
  log(`  Callback URL     : ${callbackUrl}   ← copy EXACTLY`);
  log('  (no special scope settings are needed — the CMS requests the');
  log('   "repo" scope itself when you sign in)');
  openBrowser(OAUTH_APP_URL);
  await question('\nPress Enter once the app is created and you can see its Client ID… ');

  // 6 — credentials in: client id to the toml, secret only to wrangler.
  const clientId = await ask(
    'Client ID (from the app page you just created): ',
    (value) => /^[A-Za-z0-9_-]+$/.test(value) && value.length > 0,
  );
  const clientSecret = await askSecret('Client secret (typed hidden, piped straight to wrangler — never stored): ');
  if (!clientSecret) fail('an empty client secret cannot be bound — re-run and paste the real one.');

  toml = readFileSync(tomlPath, 'utf8');
  toml = replaceSlot(toml, /^GITHUB_CLIENT_ID = ".*"$/m, `GITHUB_CLIENT_ID = "${clientId}"`);
  toml = replaceSlot(toml, /^GITHUB_REDIRECT_URI = ".*"$/m, `GITHUB_REDIRECT_URI = "${callbackUrl}"`);
  toml = replaceSlot(toml, /^OPERATOR_LOGIN = ".*"$/m, `OPERATOR_LOGIN = "${operatorLogin}"`);
  toml = replaceSlot(
    toml,
    /^CLOUDFLARE_OAUTH_REDIRECT_URI = ".*"$/m,
    `CLOUDFLARE_OAUTH_REDIRECT_URI = "${workerUrl}/auth/platform/cloudflare/callback"`,
  );
  toml = replaceSlot(
    toml,
    /^VERCEL_OAUTH_REDIRECT_URI = ".*"$/m,
    `VERCEL_OAUTH_REDIRECT_URI = "${workerUrl}/auth/platform/vercel/callback"`,
  );
  writeToml(toml);
  log('setup: wrangler.toml updated (client id, operator, redirect URIs).');

  log('\nsetup: binding the GitHub client secret to your Worker…');
  const secretPut = wrangler(['secret', 'put', 'GITHUB_CLIENT_SECRET'], {
    input: `${clientSecret}\n`,
  });
  // Scrub our only in-memory copy immediately after the pipe consumed it.
  if (secretPut.status !== 0) {
    fail('wrangler secret put failed — the secret was NOT stored anywhere by me; re-run and try again.');
  }

  // 7 — the real deploy, then a live health check.
  log('\nsetup: deploying your CMS…');
  const deploy = wrangler(['deploy']);
  if (deploy.status !== 0) fail('final deploy failed (see wrangler output above).');

  log('\nsetup: checking that the Worker answers…');
  let healthy = false;
  for (let attempt = 1; attempt <= 3 && !healthy; attempt += 1) {
    try {
      const response = await fetch(`${workerUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    if (!healthy && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  log(healthy ? 'setup: /api/health answered ok.' : 'setup: /api/health did not answer yet — usually edge propagation; open the URL below in a minute.');

  rl.close();
  log('\nsetup: done.');
  log(`\n  Your CMS        : ${workerUrl}`);
  log('  Next step      : open it and "Sign in with GitHub" as');
  log(`                    ${operatorLogin} — that login is this instance's admin.`);
  log('  Platform publishing (Cloudflare Pages / Vercel) is optional and');
  log('  configured later inside the CMS: Settings → Hosting platforms.');
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack : String(error));
});
