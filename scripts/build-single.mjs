#!/usr/bin/env node
/**
 * Single-file distribution build (implements.md §5a + §5c).
 *
 * Produces the release bundle in dist-single/:
 *   nomad-cms.worker.js — the entire CMS (API router + embedded frontend)
 *                         as one ESM Worker script;
 *   wrangler.toml       — the configuration template (copied from
 *                         scripts/wrangler.template.toml; slots filled by
 *                         setup.mjs or by hand);
 *   setup.mjs           — the interactive installer (copied from
 *                         scripts/setup.mjs).
 * Pipeline:
 *
 *  1. `npm run build` (shared → backend typecheck → frontend dist), so the
 *     embedded assets and the bundled code are always in sync;
 *  2. every frontend dist file is embedded base64 with its MIME type, an
 *     MD5 ETag, and a cache policy; the `_headers` semantics are ported
 *     1:1 (the "/*" security-header rule applies to every embedded
 *     response; /index.html keeps `max-age=0, must-revalidate`). One
 *     deliberate improvement over the Workers Static Assets default, per
 *     the plan: content-hashed /assets/* files are served immutable;
 *  3. esbuild bundles packages/backend/src/index-single.ts, resolving the
 *     virtual module 'virtual:embedded-assets' to the generated data;
 *  4. the template is validated (every setup.mjs slot present exactly
 *     once) and copied beside the Worker;
 *  5. sanity pins (no sourceMappingURL) and a byte-size report.
 *
 * The monorepo dev flow is untouched — this script is purely additive.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backendSrc = join(root, 'packages', 'backend', 'src');
const frontendDist = join(root, 'packages', 'frontend', 'dist');
const outDir = join(root, 'dist-single');
const outFile = join(outDir, 'nomad-cms.worker.js');
const templatePath = join(root, 'scripts', 'wrangler.template.toml');
const setupPath = join(root, 'scripts', 'setup.mjs');

/** MIME types mirroring what Workers Static Assets serves. */
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function fail(message) {
  console.error(`build-single: ${message}`);
  process.exit(1);
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Parses the _headers subset this project uses: `/*` and exact paths. */
function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(rawLine)) continue;
    if (/^\s/.test(rawLine)) {
      if (!current) fail('_headers file has a header line before any path pattern.');
      const separator = line.indexOf(':');
      if (separator < 1) fail(`_headers file has an unparseable header line: "${line}"`);
      const name = line.slice(0, separator).trim();
      current.headers[name] = line.slice(separator + 1).trim();
    } else {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    }
  }
  return rules;
}

async function walkFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function buildEmbeddedAssets() {
  const rules = parseHeadersFile(await readFile(join(frontendDist, '_headers'), 'utf8'));
  const sharedRule = rules.find((rule) => rule.pattern === '/*');
  if (!sharedRule || !sharedRule.headers['Content-Security-Policy']) {
    fail('dist/_headers is missing the "/*" rule with its Content-Security-Policy — refusing to ship an unprotected bundle.');
  }
  const indexRule = rules.find((rule) => rule.pattern === '/index.html');
  const htmlCache = indexRule?.headers['Cache-Control'] ?? REVALIDATE;

  const files = {};
  // Vite emits content-hashed files only under assets/; public/ files land
  // at the dist root and must always revalidate.
  const hashedName = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
  for (const fullPath of await walkFiles(frontendDist)) {
    const relativePath = relative(frontendDist, fullPath).split('\\').join('/');
    // _headers is build configuration consumed here, never served; .map
    // files must never ship (defense in depth — vite builds map-free).
    if (relativePath === '_headers' || relativePath.endsWith('.map')) continue;
    const contentType = MIME_TYPES[extname(relativePath).toLowerCase()];
    if (!contentType) fail(`no MIME type mapped for "${relativePath}" — extend MIME_TYPES in scripts/build-single.mjs.`);
    const bytes = await readFile(fullPath);
    files[`/${relativePath}`] = {
      body: bytes.toString('base64'),
      contentType,
      etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
      cacheControl:
        relativePath.startsWith('assets/') && hashedName.test(relativePath) ? IMMUTABLE : htmlCache,
    };
  }
  if (!files['/index.html']) fail('frontend dist has no index.html — run the frontend build first.');
  return { files, securityHeaders: sharedRule.headers };
}

/**
 * Slot lines setup.mjs replaces (anchored, exactly-once each). Validating
 * them here keeps the template and the installer from drifting apart: a
 * template missing a slot fails the build instead of failing at Ana's
 * terminal.
 */
const TEMPLATE_SLOTS = [
  /^name = ".*"$/m,
  /^id = ".*"$/m,
  /^preview_id = ".*"$/m,
  /^GITHUB_CLIENT_ID = ".*"$/m,
  /^GITHUB_REDIRECT_URI = ".*"$/m,
  /^OPERATOR_LOGIN = ".*"$/m,
  /^CLOUDFLARE_OAUTH_REDIRECT_URI = ".*"$/m,
  /^VERCEL_OAUTH_REDIRECT_URI = ".*"$/m,
];

async function validateAndCopyTemplate() {
  const template = await readFile(templatePath, 'utf8');
  for (const slot of TEMPLATE_SLOTS) {
    const matches = template.match(new RegExp(slot.source, 'gm'));
    if (!matches || matches.length !== 1) {
      fail(`wrangler.template.toml must contain exactly one line matching ${slot} — it has ${matches?.length ?? 0}.`);
    }
  }
  await copyFile(templatePath, join(outDir, 'wrangler.toml'));
  await copyFile(setupPath, join(outDir, 'setup.mjs'));
}

async function main() {
  console.log('build-single: running the monorepo build (shared → backend → frontend)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('monorepo build failed.');

  const embeddedAssets = await buildEmbeddedAssets();
  const generated = `// GENERATED by scripts/build-single.mjs — do not edit.
export const embeddedAssets = ${JSON.stringify(embeddedAssets)};
`;

  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [join(backendSrc, 'index-single.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    outfile: outFile,
    plugins: [
      {
        name: 'embedded-assets',
        setup(build) {
          build.onResolve({ filter: /^virtual:embedded-assets$/ }, () => ({
            path: 'embedded-assets',
            namespace: 'embedded-assets',
          }));
          build.onLoad({ filter: /.*/, namespace: 'embedded-assets' }, () => ({
            contents: generated,
            loader: 'js',
          }));
        },
      },
    ],
  });
  await validateAndCopyTemplate();

  const bundle = await readFile(outFile, 'utf8');
  if (bundle.includes('sourceMappingURL')) fail('bundle references source maps — must not ship.');
  const fileCount = Object.keys(embeddedAssets.files).length;
  const setupBytes = (await readFile(join(outDir, 'setup.mjs'))).length;
  console.log(
    `build-single: ${relative(root, outFile)} — ${fileCount} embedded files, ` +
      `${formatBytes(Buffer.byteLength(bundle))} raw, ${formatBytes(gzipSync(Buffer.from(bundle)).length)} gzipped.`,
  );
  console.log(
    `build-single: release bundle complete — nomad-cms.worker.js + wrangler.toml + setup.mjs (${formatBytes(setupBytes)}); ` +
      'verify with `npm run smoke:single` and `npm run dryrun:single`.',
  );
}

await main();
