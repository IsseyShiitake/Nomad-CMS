#!/usr/bin/env node
/**
 * Equivalence smoke for the single-file build (implements.md §5a gate).
 *
 * Starts `wrangler dev` against dist-single/wrangler.toml (local KV
 * simulation, no Cloudflare account needed) and runs the monorepo smoke
 * list: health, gated platform status, SPA render with the built CSP,
 * SPA fallback for unknown routes and missing assets, asset MIME types
 * and cache policy, _headers security semantics, 405 on non-GET, ETag
 * revalidation. Any failure exits non-zero; the dev server is always
 * stopped on the way out.
 *
 * Run `npm run build:single` first (or let this script do it).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'dist-single');
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // Server not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runChecks() {
  const health = await fetch(`${BASE}/api/health`);
  check('GET /api/health → 200', health.status === 200, `got ${health.status}`);
  check('health body is {data:{status:"ok"}}', (await health.json()).data.status === 'ok');
  check(
    'API response carries security headers',
    health.headers.get('x-content-type-options') === 'nosniff' &&
      health.headers.get('referrer-policy') === 'no-referrer',
  );

  // platform/status is intentionally public (configuration only — matches
  // the live monorepo deployment); /api/repositories proves the auth gate.
  const status = await fetch(`${BASE}/api/auth/platform/status`);
  const statusBody = await status.json();
  check(
    'GET /api/auth/platform/status → 200, both platforms unavailable (matches live)',
    status.status === 200 &&
      Array.isArray(statusBody.data) &&
      statusBody.data.length === 2 &&
      statusBody.data.every((entry) => entry.available === false),
    `got ${status.status} ${JSON.stringify(statusBody).slice(0, 120)}`,
  );
  const repositories = await fetch(`${BASE}/api/repositories`);
  const repositoriesBody = await repositories.json();
  check(
    'GET /api/repositories unauthenticated → 401 unauthorized',
    repositories.status === 401 && repositoriesBody.error.code === 'unauthorized',
    `got ${repositories.status} ${JSON.stringify(repositoriesBody).slice(0, 120)}`,
  );

  const home = await fetch(`${BASE}/`);
  const homeText = await home.text();
  check('GET / → 200 text/html', home.status === 200 && home.headers.get('content-type') === 'text/html', `got ${home.status} ${home.headers.get('content-type')}`);
  check('SPA HTML renders (title present)', homeText.includes('<title>Nomad CMS</title>'));
  const builtHtml = await readFile(join(root, 'packages', 'frontend', 'dist', 'index.html'), 'utf8');
  const builtCsp = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/.exec(builtHtml)?.[1];
  check(
    'CSP header equals the built index.html policy (1:1 _headers port)',
    !!builtCsp && home.headers.get('content-security-policy') === builtCsp,
    home.headers.get('content-security-policy') ?? 'none',
  );
  check(
    'security headers on /',
    home.headers.get('x-content-type-options') === 'nosniff' &&
      home.headers.get('x-frame-options') === 'DENY' &&
      home.headers.get('referrer-policy') === 'no-referrer',
  );
  check(
    'index.html cache policy',
    home.headers.get('cache-control') === 'public, max-age=0, must-revalidate',
    home.headers.get('cache-control') ?? 'none',
  );
  const homeEtag = home.headers.get('etag');
  check('ETag served on /', !!homeEtag);

  const scriptSrc = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(homeText)?.[1];
  check('index.html references a bundled script', !!scriptSrc);
  if (scriptSrc) {
    const js = await fetch(`${BASE}${scriptSrc}`);
    check(
      `GET ${scriptSrc} → 200 text/javascript, immutable`,
      js.status === 200 &&
        js.headers.get('content-type') === 'text/javascript' &&
        js.headers.get('cache-control') === 'public, max-age=31536000, immutable',
      `got ${js.status} ${js.headers.get('content-type')} ${js.headers.get('cache-control')}`,
    );
  }

  const cssHref = /<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+\.css)"/.exec(homeText)?.[1];
  check('index.html references a stylesheet', !!cssHref);
  if (cssHref) {
    const css = await fetch(`${BASE}${cssHref}`);
    check(
      `GET ${cssHref} → 200 text/css, immutable`,
      css.status === 200 &&
        css.headers.get('content-type') === 'text/css' &&
        css.headers.get('cache-control') === 'public, max-age=31536000, immutable',
      `got ${css.status} ${css.headers.get('content-type')} ${css.headers.get('cache-control')}`,
    );
  }

  const spa = await fetch(`${BASE}/settings/connections`);
  check(
    'SPA fallback for unknown route → 200 text/html, same ETag as /',
    spa.status === 200 &&
      spa.headers.get('content-type') === 'text/html' &&
      !!homeEtag &&
      spa.headers.get('etag') === homeEtag,
    `got ${spa.status} ${spa.headers.get('content-type')} ${spa.headers.get('etag')}`,
  );
  const missing = await fetch(`${BASE}/assets/definitely-missing-9x.js`);
  check(
    'missing asset also falls back to index.html (200 text/html)',
    missing.status === 200 && missing.headers.get('content-type') === 'text/html',
    `got ${missing.status} ${missing.headers.get('content-type')}`,
  );
  const headersFile = await fetch(`${BASE}/_headers`);
  check(
    '/_headers is config, never served as a file (falls back to SPA)',
    headersFile.status === 200 && headersFile.headers.get('content-type') === 'text/html',
    `got ${headersFile.status} ${headersFile.headers.get('content-type')}`,
  );

  const revalidated = await fetch(`${BASE}/`, { headers: { 'If-None-Match': homeEtag ?? '' } });
  check('If-None-Match with the current ETag → 304', revalidated.status === 304, `got ${revalidated.status}`);

  const post = await fetch(`${BASE}/`, { method: 'POST' });
  check(
    'POST / → 405, empty body, security headers kept',
    post.status === 405 &&
      post.headers.get('x-content-type-options') === 'nosniff' &&
      (await post.text()) === '',
    `got ${post.status}`,
  );

  const head = await fetch(`${BASE}/`, { method: 'HEAD' });
  check('HEAD / → 200, no body', head.status === 200 && head.body === null, `got ${head.status}`);
}

async function main() {
  if (!existsSync(join(outDir, 'nomad-cms.worker.js'))) {
    console.log('smoke-single: no bundle found — running build:single first…');
    const build = spawnSync('npm', ['run', 'build:single'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) process.exit(1);
  }

  const tail = [];
  const wrangler = spawn(
    'npx',
    ['wrangler', 'dev', '--config', join('dist-single', 'wrangler.toml'), '--port', String(PORT)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  wrangler.stdout.on('data', (chunk) => tail.push(`  ${chunk}`.slice(-2000)));
  wrangler.stderr.on('data', (chunk) => tail.push(`  [stderr] ${chunk}`.slice(-2000)));
  const stop = () => {
    wrangler.kill('SIGTERM');
    wrangler.stdout.destroy();
    wrangler.stderr.destroy();
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(1);
  });

  console.log(`smoke-single: starting wrangler dev on 127.0.0.1:${PORT}…`);
  if (!(await waitForHealth(60000))) {
    console.error('smoke-single: dev server never became healthy. Output tail:');
    console.error(tail.join('').slice(-3000));
    stop();
    process.exit(1);
  }

  try {
    await runChecks();
  } catch (error) {
    console.error(`smoke-single: check crashed: ${error instanceof Error ? error.stack : error}`);
    failures += 1;
  } finally {
    stop();
  }

  console.log(failures === 0 ? 'smoke-single: ALL CHECKS PASSED' : `smoke-single: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
