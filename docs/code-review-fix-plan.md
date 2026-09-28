# Code Review — Consolidated Fix Plan

Date: 2026-09-25 · Status: **IMPLEMENTED 2026-09-26** (all P0–P3 items + safe P4s;
P4-3/P4-5/P4-6 and the KV RMW races remain intentionally open — see log.md
2026-09-26 for the follow-up review rounds that ran after this plan landed)
Sources: two independent full-code reviews (this session + a second reviewer),
cross-verified against source line-by-line. Every item below was confirmed in
code before being listed; no item rests on a doc claim alone.

Scope note: findings already tracked elsewhere are referenced, not restated:
operator pinning = `implements.md` §4 (Phase 2); per-request AES key import =
accepted in `log.md` ("audit item intentionally unchanged").

Priority legend: P0 = security, ship first · P1 = user-visible functional bugs
· P2 = robustness/config hygiene · P3 = dead code & docs · P4 = optimizations.

---

## P0 — Security

### P0-1. Repo lock not enforced on `GET /api/repositories/:owner/:repo/pages/:path`
`packages/backend/src/routes/repositories.ts:350` computes
`const locked = ensureRepo(...)` but never returns it — the
`if (locked) return locked;` line present in all 7 sibling blocks is missing.
A client session locked to repo A can read any `.html`/`.htm` file reachable
by the session's backing (admin) GitHub token, including private repos.
Writes/contents/raw/images remain locked; only page reads leak.

Fix: add the missing `if (locked) return locked;`.
Acceptance: new backend test — client session + foreign owner/repo on the
pages/:path route → 403 (the existing lock test covers only `/raw/`).
Enabling `noUnusedLocals` in the backend tsconfig (P2-6) would have caught
the dead variable at compile time.

### P0-2. Operator pinning (known, planned — restated for completeness)
`POST /api/auth/exchange` (`routes/auth.ts:292`) grants `kind: 'admin'` to
every GitHub login; `/api/clients*` and platform connect are then open to any
sign-in. Already designed in `implements.md` §4 (KV `operator:login` claim +
`OPERATOR_LOGIN` override). Execute Phase 2 before any public distribution.

---

## P1 — Functional bugs

### P1-1. A rejected platform token signs the whole UI out
`packages/frontend/src/api/client.ts:108` fires the global unauthorized
handler on **any** 401 outside `/api/auth`, but the backend deliberately
returns `401 platform_token_invalid` (with marker header
`x-cms-platform-token-invalid: 1`, `services/deploy/index.ts:51`) while the
CMS session is healthy. Typing a wrong token in Settings, or a poll hitting
an expired platform token (`routes/deploy.ts:200`, resolve-links total
failure), flips the app to the signed-out screen; the cookie is intact and a
reload restores the session.

Fix: trigger `onUnauthorized` only for error code `unauthorized` (the
session-dead 401s — including the GitHub-token-invalid one, which also uses
that code and must keep firing), not for every 401. Alternatively honor the
marker header.
Acceptance: unit test — ApiClientError with code `platform_token_invalid`
does not invoke the handler; code `unauthorized` does.

### P1-2. Cloudflare project/deployment URLs lack a scheme — live links broken
`services/deploy/cloudflare.ts:97` returns bare hostnames
(`domains[0]`, `subdomain.pages.dev`) while the Vercel client correctly
prefixes `https://` (`services/deploy/vercel.ts:90`). Consequences:
PublishPanel's `<a href>` navigates inside the SPA (404 page), and RepoTile's
`new URL(candidate)` throws for platform live URLs.

Fix: normalize at the mapping boundary (`https://${host}` when no scheme).
Acceptance: `mapProject`/`mapDeployment` tests pin the scheme; PublishPanel
link opens the live site.

### P1-3. RepoTile tier-1 miniatures dead for everything except `*.github.io`
`ui/components/RepoTile.tsx:88` (`previewSrc`) routes only `.github.io`
through the same-origin `/api/preview` proxy; platform live URLs and custom
homepages are preflighted with a direct cross-origin `fetch`
(`RepoTile.tsx:190`), which rejects without CORS headers — i.e. nearly every
static site — so the candidate is skipped even when live. The backend proxy
already allows `.pages.dev` and `.vercel.app` (`routes/preview.ts:35`).

Fix: extend `previewSrc` to proxy all three host suffixes; keep direct
framing only as an explicit fallback. (P1-2 must land first or CF URLs never
parse.)
Acceptance: a pages.dev/vercel.app-backed repo tile renders the live capture
without the 9s tier-2 fallback delay.

### P1-4. Client sessions can never see deployment state (dead feature)
`routes/deploy.ts:271` resolves links via `connectionOwner = login`, and a
client session's login is the synthetic label (`routes/auth.ts:79`), while
connections are keyed by the admin's GitHub login — the lookup always misses,
so links/status are always `[]` for clients. The code comment above line 271
is truncated mid-sentence (unfinished work). `docs/hosting-platforms.md`
promises the feature; `ClientPagesPage` mounts a PublishPanel that can only
render null after a wasted API call. Latent wart: a client label equal to an
admin's login collides with `deploy:<login>:<platform>` keys.

Fix (decision needed): either (a) resolve client links through the access
record's `createdBy` admin (store `createdBy`/owner in the client session and
use it as connectionOwner, still read-only + repo-locked), or (b) drop the
client-facing promise (remove the panel mount for clients, fix the doc).
Acceptance: whichever path — a test asserting client links are non-empty (a)
or that no links call is made (b).

### P1-5. Per-client UI language is write-only
The backend stores `language` and Settings edits it, but no frontend code
ever reads `access.language`; `setLocale` is only called from the manual
toggles, and client login *overwrites* the stored locale with the browser's
current one (`features/login/ClientLoginPage.tsx:129`). The preference
round-trips to nowhere.

Fix (decision needed): expose the client's language on the session
(`SessionInfo`, set at client-login) and apply it on restore; or remove the
feature. As shipped, the Settings language selector for clients is decorative.

### P1-6. Re-uploading an image with the same filename fails (422 → 502)
`services/github/client.ts:334` `uploadImage` never sends the existing blob's
`sha`, so GitHub answers 422 when the path already exists; it surfaces as a
generic 502. The route already lists images (`routes/repositories.ts:500`) —
the current sha is available.

Fix: look up the existing sha (from the images listing or a contents GET)
and pass it so the upload becomes an update; keep 422 mapping honest.
Acceptance: upload `foo.png` twice → second upload replaces the file.

### P1-7. Duplicate React keys when 2+ Vercel-direct projects exist
`services/deploy/vercelDirect.ts:28` maps every virtual repo to `id: 0`;
`RepositoriesPage.tsx:172` and `SettingsPage.tsx:215` use `key={repo.id}`.
Two or more direct projects → duplicate keys → React reconciliation bugs.

Fix: synthesize a stable id (e.g. negative hash of `vercel/<name>`) or key
by `fullName`.

### P1-8. Publish polling timeout leaves the chip stuck on "building"
`services/publish/index.ts:118` sets a non-busy `building` phase on timeout,
but PublishPanel's auto-reset only watches `done`/`failed`
(`features/publish/PublishPanel.tsx:45`).

Fix: either reset after the timeout too, or introduce a distinct
`gave-up/unknown` phase with its own label.

### P1-9. Split-domain deployments: preview asset base and preview route break
`features/editor/EditorView.tsx:156` and `RepoTile.tsx:225` build the raw
asset `baseHref` from `window.location.origin`, ignoring
`config.apiBaseUrl` that the API client honors; and `/api/preview` is
deliberately not passed through `finalizeResponse` (`routes/index.ts:50`),
so it emits no CORS headers — cross-origin preflight fetches fail. Default
same-origin deployment is unaffected.

Fix: derive `baseHref` from `config.apiBaseUrl || origin`; give the preview
route CORS treatment (it already sets its own security headers, so layer
`corsHeaders` only). Alternatively document split-domain as unsupported for
the visual preview until fixed.

### P1-10. Client access can be created for a virtual `vercel/<project>` repo — permanently broken
The Settings repo dropdown lists Vercel-direct virtual repos;
`POST /api/clients` does not reject `repoOwner: "vercel"`. Such a client's
workspace can only 404 (list route calls GitHub `getRepository('vercel', …)`;
page routes 404 in `resolveDirect` for client kind).

Fix: validate at create time (reject the virtual owner) or make the locked
list route direct-aware. Low effort, prevents an unrecoverable access.

### P1-11. Repository listing silently truncates at 100
`services/github/client.ts:198` — one `per_page=100` call, no Link/cursor
pagination (the CF and Vercel clients paginate). Users with 100+ repos lose
the tail with no indication.

Fix: follow GitHub pagination (page param until a short page, bounded like
the CF client's 50-page cap).

### P1-12. Page discovery placeholders make the title UI branches dead
`routes/repositories.ts:332` and `services/deploy/vercelDirect.ts:95`
hardcode `title: null` (and `editableElementCount: 0`), so the
`page.title ? …` branches in `PagesPage.tsx:199` / `ClientPagesPage.tsx:133`
never render in production — only in tests (fixtures use non-null titles).

Fix (decision needed): derive a title (filename or `<title>` extraction) or
delete the branches and the `title` field.

### P1-13. `.dev.vars.example` omits `SESSION_ENCRYPTION_KEY`
The example lists only the GitHub + platform secrets; the crypto layer
throws without the key and `scripts/seed-local.mjs` aborts. A fresh setup
following the example gets a Worker whose session ops all 500.

Fix: add the key with a generation one-liner comment (matches
`docs/deployment.md` §2.3).

---

## P2 — Robustness & config hygiene

1. **No upstream timeouts; unbounded bodies.** Zero `AbortSignal` on backend
   fetches (GitHub, platforms, preview proxy). `routes/preview.ts` buffers
   `upstream.text()` unbounded; the PUT pages route has no content-size gate
   (the image route does — mirror it). Frontend aborts at 30s client-side
   only.
2. **Upload UX gaps.** No client-side size pre-check before POST (an
   oversized pick uploads fully, then 413s); `accept="image/*"` in
   `ElementEditor` permits SVG picks that the backend rejects only at
   save time. Restrict `accept` to the shared allowlist; pre-check
   `MAX_IMAGE_BYTES`.
3. **Repo-lock comparison is case-sensitive** (`routes/repositories.ts:83`)
   while GitHub logins are case-insensitive — normalize both sides.
4. **JSON responses carry no `Cache-Control`** (`core/http.ts` json/jsonError).
   Add `no-store` as defense-in-depth for authenticated GETs. (Not an active
   bug — responses lack validators, so heuristic caching is unlikely — but
   the header makes it explicit.)
5. **Two CSP sources can drift.** `index.html` meta and `public/_headers`
   already differ (`form-action 'self'` only in the meta). Generate one from
   the other (extend the `cspPlugin`) or diff them in CI.
6. **Backend tsconfig:** add `noUnusedLocals`/`noUnusedParameters` — would
   have caught P0-1 at compile time. Also `"build": "tsc -p tsconfig.json"`
   with `noEmit: true` is a typecheck, not a build (wrangler bundles src
   directly); rename or make it emit nothing intentionally documented.
7. **`ConfirmDialog` lacks the portal + Escape handling `Modal` has** —
   latent only (no filtered ancestors in current usages: ElementEditor rows,
   SettingsPage). Port `createPortal` + Escape for parity before the next
   filtered-ancestor usage appears.
8. **GET requests send `Content-Type: application/json`** (`api/client.ts`)
   — needless CORS preflights on simple GETs in split-domain mode. Set it
   only when a body is present.
9. **`seed-local.mjs` imports `node:sqlite`** (Node ≥22.5) while root
   `engines` allows ^20.19 — crashes obscurely on Node 20. Guard with an
   explicit version check or bump the script's documented requirement.
10. **Hidden sourcemaps are still deployed.** `sourcemap: 'hidden'` omits the
    link comment but still emits `.map` files into `dist/assets/` (52 files
    at last build), which Workers Static Assets serves — original TS
    recoverable. Set `sourcemap: false` for production builds, or exclude
    `*.map` from the assets directory. (Moot-ish once the repo is public per
    implements.md D1, until then it leaks source.)
11. **`POST /api/repositories` (root) still lists repositories**
    (`routes/repositories.ts:154`, no method guard) — enforce 405 like the
    subroutes.

---

## P3 — Dead code & documentation drift

Dead code (all verified with zero production usages):

- `ui/components/Placeholder.tsx` — entire file, 0 imports.
- `RepoTile` `label` prop — no production caller passes it (test-only).
- `FloatingControls` `className` prop — never passed.
- `CloudflarePagesClient.verify()` and `.getProject()` — no production
  callers (connect route uses `listProjects()` for CF; `getProject` callers
  are all `VercelClient`).
- `VercelClient.getDeployment()` — zero callers anywhere.
- `SessionManager.getGitHubToken()` — test-only.
- `isVercelDirect()` (`routes/vercelDirect.ts:66`) — zero callers.
- `DirectStorage` interface (`services/deploy/vercelDirect.ts:45`) — unused.
- `VercelDirectStore.repository` / `.latest` getters — unused.
- `InMemoryEditorController.discard()` — unused (UI has no discard).
- `DomHtmlScanner` class + `HtmlScanner`/`ScannedDocument`/`DetectedElement`
  — production-dead since the scanner panel deletion (only
  `buildUniqueSelector` + the selector constants are live imports). Log says
  retention was deliberate — decide: keep with a comment, or remove.
- `ImageManager.deleteImage` — throwing stub, never called.
- Shared types: `GetSessionResponse` (also wrong — `UserProfile | null` vs
  the actual `SessionInfo | null`), `Branch`, `ownerAvatarUrl` (written,
  never read), `DeployProject.productionBranch` (written, never read).
- Unreachable branches: `ClientLoginPage` `err.code === 'locked'` (backend
  never emits it — locked accounts deliberately get `invalid_credentials`);
  `HostingPlatformsCard.load()`'s `platform_token_invalid` branch (GET
  /connections is KV-only); controller fallback `'save_failed'` renders raw
  while `m.editor.saveFailed` exists unused.
- Dead i18n keys (both locales): `app.tagline`, `auth.githubInstead`,
  `login.languageChoice`, `login.locked`, `editor.title`, `editor.saveFailed`,
  `repositories.loading`, `common.comingLater`.
- Test placement/gaps: `path.test.ts` lives in backend testing `@cms/shared`
  (shared has no runner); `safeAssetPath` and `encodePath` untested.

Documentation drift (verified against code — fix alongside the code items):

- `docs/tutorial-beginners.md` — references deleted
  `VITE_GITHUB_CLIENT_ID`/`VITE_GITHUB_REDIRECT_URI`; claims the frontend
  builds the sign-in link (server-built since Sept); omits
  `SESSION_ENCRYPTION_KEY` from its `.dev.vars` sample; shows localhost
  wrangler.toml values where the file holds production ones; "Why twice?"
  rationale obsolete. As the beginner entry point it breaks a fresh setup.
- `docs/static-assets.md` — CSP block stale (old
  `raw.githubusercontent.com` policy vs shipped fonts policy), references
  removed `VITE_GITHUB_REDIRECT_URI`, worker still named `cms-backend`.
- `docs/architecture.md` — lists the deleted settings route/service and a
  nonexistent frontend "GitHub service"; diagram names the old worker.
- `docs/github-app.md` — stale `VITE_GITHUB_CLIENT_ID` guidance.
- `docs/cloudflare-worker.md` — bindings table omits `SESSION_ENCRYPTION_KEY`,
  the platform OAuth vars, `ALLOWED_ORIGINS`; secrets step lists only one of
  the two required secrets.
- `docs/hosting-platforms.md` — "Nothing changes in wrangler.toml" predates
  platform OAuth (client ids + secrets now exist); no OAuth flow mention;
  client deployment-state promise depends on P1-4's decision.
- `docs/deployment.md` — example URLs use the old `cms-backend` worker name.
- `README.md` (module layout) — routes list still includes `settings`.
- `docs/production-checklist.md` — `ALLOWED_ORIGINS` listed as a
  before-deploy requirement; it is only needed for split-domain deployments.
- `wrangler.toml` comment — says `wrangler kv namespace create
  SESSIONS_NOMAD` while the binding is `SESSION_KV`.

---

## P4 — Optimizations (no behavior change)

1. **Per-keystroke full re-parse** — every textarea change runs `DOMParser`
   over the whole document plus `querySelectorAll` + `buildUniqueSelector`
   per element (`services/htmlParser/parser.ts:120`). The 250ms debounce
   covers only the preview iframe, not the model update. Throttle or make
   the model update incremental for large pages.
2. **Cloudflare connect verification paginates all projects** (up to 50
   requests, `routes/deploy.ts:181`) — a `per_page=1` probe verifies the
   token/account pair equally well.
3. **`/projects`, link resolution and status polling re-list every project
   sequentially per platform on every call** (and every 5s poll during
   publishing) — parallelize the two platforms and/or briefly cache the
   listings.
4. **RepositoriesPage awaits the repo list then the project list
   sequentially** (`load()`) — use `Promise.all` like SettingsPage.
5. **Duplicate `listPages` on pages views** — `PagesPage`/`ClientPagesPage`
   call `listPages` for the list, and the banner RepoTile's tier-2 calls it
   again plus `getPage` when no live site exists.
6. **Vercel-direct per-asset amplification** — each `/raw/...` request for a
   `vercel/<project>` repo costs a KV read + `getProject` + a full file-tree
   fetch + the file read (~3 upstream calls per asset). Cache the resolved
   project/tree per request burst.
7. **KV read-modify-write races** (low probability, worth knowing):
   `ClientStore.update` can lose concurrent failed-attempt increments
   (slightly weakens lockout under parallel attack); `ConnectionStore.touch`
   (get→put) can theoretically clobber a just-rotated OAuth token written by
   `runWithConnection`'s refresh under KV eventual consistency.
8. **Client-login timing side channel** — locked/revoked records return
   before the PBKDF2 burn, so lockout state is distinguishable by latency
   despite the anti-enumeration design (the `DUMMY_SALT` burn exists for
   unknown IDs only). Minor; burn comparable time on the locked path too.
9. **Modulo bias in `generatePassword`** (`services/auth/password.ts`) —
   `256 % 56 = 32`; first 32 alphabet chars ~25% likelier (ID alphabet is
   exactly 32 chars — unbiased). Negligible practically; rejection sampling
   is the correct pattern if touched.

---

## Suggested execution order

1. P0-1 (one line + test) and P2-6 (tsconfig flags) — immediately.
2. P1-1, P1-2, P1-3 (platform token UX + CF URLs + tile proxy) — one
   coherent platform-UX batch.
3. P1-4, P1-5, P1-12 (client feature decisions) — needs a product call on
   each: fix vs remove.
4. P1-6..P1-11, P1-13 — independent small fixes.
5. P2 remainder, then P3 sweep (one PR for dead code, one for docs), P4 as
   opportunity permits.

## Validation protocol per change

- `npm run typecheck`; backend `npx vitest run` (150); frontend
  `npx vitest run` (100) — keep green, extend for new behavior.
- After touching `packages/shared`: rebuild it or backend tsc fails
  confusingly (resolves `@cms/shared` from `dist/`).
- Deploy only from the repo root (`npm run deploy`); never with worker name
  `cms-backend` in wrangler.toml.
