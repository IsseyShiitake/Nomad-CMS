# GitHub Token Refresh (Option B) Implementation Plan

> **Executor note:** implement task-by-task with the executing-plans skill (inline, this
> harness's default) or per-task fresh-context dispatch — the orchestrator decides.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every GitHub-backed session (admin and client) alive transparently by implementing GitHub's OAuth refresh-token flow, so 8-hour expiring tokens no longer kill client accesses or bounce the admin.

**Architecture:** One canonical rotating grant per admin login lives in KV (`github-grant:<login>`, AES-GCM encrypted, same scheme as sessions). Sessions and client records cache only the access token + its expiry; all refreshes go **through the grant**, because GitHub refresh tokens are single-use rotating — copies stored in multiple records would desync on the first rotation. `SessionManager.getSession` (the chokepoint every authenticated request already passes) refreshes near-expiry tokens; client login does the same via the record's `createdBy`. Admin `/exchange` saves the grant and re-anchors every client access it created, which revives legacy records (Elisabeth, September) **without password changes or recreation**.

**Tech Stack:** TypeScript (strict) on Cloudflare Workers (WebCrypto, KV), React 19 frontend, Vitest (backend Node env, frontend jsdom), existing `vi.stubGlobal('fetch', …)` + in-memory `mockKv()` harnesses.

**Spec:** diagnosis in `log.md` entries 2026-11-17 17:54 / 18:10; GitHub behavior per
[OAuth app token refresh changelog (2026-08-14)](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/)
and [Authorizing OAuth apps § Expiring access tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
This plan is self-contained; the executor needs nothing else.

## Global Constraints

- **Precondition (STOP if unmet):** `git status --short` must be empty at start. The pending cookie/CSP change set (touches `routes/auth.ts`) must be committed to `main` by the orchestrator/ravi first. If the tree is dirty, stop and report — do not stash, revert, or build on top of it.
- Work on a new branch `feat/github-token-refresh` created from `main`. Commit per task. **No `git push`, no deploy** — merge/push/deploy are gated on orchestrator review + ravi approval.
- TDD: write the failing test, run it, **watch it fail**, then implement, then watch it pass. No implementation before a watched red.
- No new dependencies. No Node-only APIs in `packages/backend/src/**` (Workers runtime: WebCrypto `crypto.subtle`, `fetch`, `atob`/`btoa` only). Tests may use Node.
- Secrets hygiene: never read or print `packages/backend/.dev.vars`. Test fixtures use dummy tokens (`gho_dummy-…`). No token value (access or refresh) may appear in error messages, `console.*` output, or API responses.
- All existing tests stay green **unmodified**, except the message-assertion updates pinned in Task 7.
- EN/FR parity for every user-facing string change (both blocks in `packages/frontend/src/i18n/messages.ts`).
- KV write discipline: no per-request writes. Refresh writes happen only on actual rotation or the existing once-per-day session slide.
- Single-file bundle budget: `dist-single/nomad-cms.worker.js` ≤ **819200 bytes** (800×1024); `build:single`, `smoke:single`, `dryrun:single` must pass (Task 8).
- Commands: root `npm run typecheck`, `npm test`; single backend file `npx vitest run <path>` from `packages/backend`; single frontend file from `packages/frontend`.
- Commit message style matches history: `feat(auth): …`, `fix(auth): …`, `test(auth): …`, `docs: …`.

## Review Focus

Failure modes the spec implies; each is pinned to a test in the owning task:

1. **Concurrent refresh, one grant** (admin tab + client tab hit expiry together): the second caller's refresh is rejected by GitHub (single-use rotation) but must recover by re-reading the rotated grant — the user is not bounced. → Task 2 `recovers via grant re-read when a concurrent request already rotated it`; Task 3 client+admin share one grant.
2. **Refresh rejected with expired access** (`bad_refresh_token`, revoked grant, 6-month lapse): fail closed — admin `getSession` → null; client login → **403 `backing_token_invalid`, never 401 `invalid_credentials`** (the password was correct). → Tasks 2, 3, 5.
3. **Transient GitHub outage during the 5-min margin**: keep serving the still-valid cached token; after hard expiry with no refresh possible, fail closed. → Task 2 `serves cached token on transient failure while still valid` / `fails closed after hard expiry`.
4. **Legacy records/sessions without the new fields** (all production data today): identical behavior, zero refresh attempts, no crash on `undefined`. → Tasks 3, 5, 6.
5. **Non-expiring app mode** (opt-out / GHES: exchange returns no `refresh_token`): never attempt refresh; re-anchor still copies the long-lived token. → Tasks 1, 4.
6. **Re-anchor merge safety**: `passwordHash`, `salt`, `requireApproval`, `revoked`, `failedAttempts`, `lockedUntil`, `label`, `repo`, `createdBy`, `createdAt`, `language`, `lastUsedAt` byte-identical after re-anchor. → Task 4.
7. **Secret hygiene**: refresh token encrypted at rest, absent from `toAccess()`/API payloads, absent from thrown-error messages. → Tasks 1, 2.
8. **Grant TTL**: `refreshExpiresAt` → KV `expirationTtl` (min 60 s); rotation resets it; non-expiring grant persists with no TTL. → Task 2.
9. **Daily session slide must not drop the new expiry field** (the renewal block lists fields manually). → Task 3 `sliding renewal preserves githubTokenExpiresAt`.
10. **Login-form truthfulness**: a dead backing token at login shows the "ask the administrator" message, not "Invalid access ID or password". → Task 7.

## File Structure

| File | Action | Owns |
| --- | --- | --- |
| `packages/backend/src/services/auth/oauth.ts` | Modify | `GitHubTokenPair`, pair parsing in exchange, `refreshGitHubToken`, `RefreshTokenRejectedError` |
| `packages/backend/src/services/auth/githubGrant.ts` | Create | `GitHubGrantStore` (load/save/remove/resolveFreshAccessToken), `GitHubOAuthConfig`, `TOKEN_REFRESH_MARGIN_MS`, grant KV layout + TTL |
| `packages/backend/src/services/auth/githubGrant.test.ts` | Create | Grant store tests (Task 2) |
| `packages/backend/src/services/auth/oauth.test.ts` | Create | Exchange/refresh unit tests (Task 1) |
| `packages/backend/src/services/auth/session.ts` | Modify | `SessionRecord.githubTokenExpiresAt`, optional OAuth config, expiry params, refresh inside `getSession`, slide-block fix |
| `packages/backend/src/services/auth/session.test.ts` | Modify | Session refresh integration tests (Task 3) |
| `packages/backend/src/services/auth/clients.ts` | Modify | `ClientRecord.githubTokenExpiresAt` only (no refresh token in client records — deliberate) |
| `packages/backend/src/services/auth/index.ts` | Modify | Re-exports of the new symbols |
| `packages/backend/src/routes/auth.ts` | Modify | `/exchange` (pair, grant save, re-anchor), `/client-login` (grant resolve, 403), SessionManager config |
| `packages/backend/src/routes/auth.test.ts` | Modify | Tasks 4–5 route tests |
| `packages/backend/src/routes/clients.ts` | Modify | `requireAdmin` returns expiry; creation snapshots it; SessionManager config |
| `packages/backend/src/routes/clients.test.ts` | Modify | Task 6 creation test |
| `packages/backend/src/routes/repositories.ts:80`, `review.ts:30`, `deploy.ts:77-80`, `preview.ts:83-86` | Modify | Pass OAuth config to SessionManager (mechanical) |
| `packages/backend/src/routes/index.ts:42` | **Unchanged** | Purge middleware only deletes sessions; no config needed |
| `packages/frontend/src/features/login/ClientLoginPage.tsx:141-146` | Modify | Map `backing_token_invalid` → `m.client.backingTokenInvalid` |
| `packages/frontend/src/features/login/ClientLoginPage.test.tsx` | Modify | Task 7 login-error test |
| `packages/frontend/src/i18n/messages.ts:579-580, 938-939` | Modify | EN/FR wording: admin action is "sign in again", not "recreate" |
| `packages/frontend/src/features/client/ClientPagesPage.test.tsx:120` (+ any grep hits) | Modify | Updated string assertion |
| `docs/github-app.md` | Modify | Expiring-tokens section (Task 8) |

---

### Task 1: OAuth token pair + refresh grant (`oauth.ts`)

**Files:**
- Modify: `packages/backend/src/services/auth/oauth.ts`
- Test: `packages/backend/src/services/auth/oauth.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface GitHubTokenPair { accessToken: string; refreshToken: string | null; accessExpiresAt: number | null; refreshExpiresAt: number | null }` (absolute epoch **milliseconds**; `null` = non-expiring / not provided)
  - `class RefreshTokenRejectedError extends Error` (GitHub rejected the refresh token itself)
  - `exchangeCodeForToken(clientId: string, clientSecret: string, code: string, redirectUri?: string): Promise<GitHubTokenPair>` (**signature change** — previously returned `string`; the only production caller is `routes/auth.ts` `/exchange`, updated in Task 4; until then keep the repo compiling by doing Task 4's caller update in the same commit if typecheck requires — see Step 3 note)
  - `refreshGitHubToken(clientId: string, clientSecret: string, refreshToken: string): Promise<GitHubTokenPair>`

- [ ] **Step 1: Write the failing tests** — `oauth.test.ts`, harness `vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({...}), { status: 200, headers: { 'Content-Type': 'application/json' } })))`, `afterEach(vi.unstubAllGlobals)`. Test names + key assertions:
  - `exchange parses the expiring pair` — response `{ access_token: 'gho_dummy-a', token_type: 'bearer', scope: 'repo', expires_in: 28800, refresh_token: 'ghr_dummy-r', refresh_token_expires_in: 15897600 }` → `accessToken === 'gho_dummy-a'`, `refreshToken === 'ghr_dummy-r'`, `accessExpiresAt` within `[before + 28800_000, after + 28800_000]` (capture `Date.now()` around the call), `refreshExpiresAt` likewise with `15897600_000`.
  - `exchange tolerates a non-expiring response` — `{ access_token, token_type, scope }` only → `refreshToken === null`, both expiries `null`.
  - `refresh posts the refresh grant and parses the rotated pair` — assert the mocked fetch was called with `https://github.com/login/oauth/access_token`, method POST, body containing `grant_type=refresh_token` and `refresh_token=ghr_dummy-r` and `client_id`/`client_secret`; response pair parsed as above.
  - `refresh maps bad_refresh_token to RefreshTokenRejectedError` — response `{ error: 'bad_refresh_token', error_description: '…' }` → `rejects.toBeInstanceOf(RefreshTokenRejectedError)`; also `error: 'invalid_grant'`.
  - `refresh rejects a response missing refresh_token` — `{ access_token: 'gho_dummy-a', expires_in: 28800 }` → rejects (rotation must return a new refresh token).
  - `error messages never contain token values` — rejection messages above do not include `ghr_dummy-r` / `gho_dummy-a`.
- [ ] **Step 2: Run, verify red** — `npx vitest run src/services/auth/oauth.test.ts` from `packages/backend`; expected: failures (functions/types absent).
- [ ] **Step 3: Implement** — extend the private `TokenResponse` with optional `expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number`. Exchange: keep existing state/error handling verbatim; return the pair, computing `typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null` (same for refresh). `refreshGitHubToken`: POST the same endpoint with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`, `Accept: application/json`, 30 s timeout (mirror exchange); on `data.error === 'bad_refresh_token' || data.error === 'invalid_grant'` throw `RefreshTokenRejectedError` (message = the error code only); other failures throw `Error` with GitHub's error code/status, never token values; success requires both `access_token` and `refresh_token`. **Compile note:** update the `/exchange` call site minimally now (`const pair = await exchangeCodeForToken(...); new GitHubClient(pair.accessToken)`) so typecheck stays green; the full `/exchange` behavior lands in Task 4.
- [ ] **Step 4: Run, verify green** — same command, all pass; then `npm run typecheck` at root, 0 errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(auth): parse GitHub OAuth token pairs and add the refresh grant"`

---

### Task 2: Canonical grant store (`githubGrant.ts`)

**Files:**
- Create: `packages/backend/src/services/auth/githubGrant.ts`
- Test: `packages/backend/src/services/auth/githubGrant.test.ts` (create)

**Interfaces:**
- Consumes: `GitHubTokenPair`, `refreshGitHubToken`, `RefreshTokenRejectedError` (Task 1); `encryptSecret`/`decryptSecret`/`importAesKey` from `./crypto` (same pattern as `ClientStore`).
- Produces:
  - `interface GitHubOAuthConfig { clientId: string; clientSecret: string }`
  - `const TOKEN_REFRESH_MARGIN_MS = 300_000` (5 minutes)
  - `class GitHubGrantStore { constructor(kv: KVNamespace, encryptionKey: string); load(login: string): Promise<GitHubTokenPair | null>; save(login: string, pair: GitHubTokenPair): Promise<void>; remove(login: string): Promise<void>; resolveFreshAccessToken(login: string, oauth: GitHubOAuthConfig): Promise<{ accessToken: string; accessExpiresAt: number | null } | null> }`
  - KV layout: key `github-grant:<login>`; value JSON `{ accessToken: <enc>, refreshToken: <enc> | null, accessExpiresAt: number | null, refreshExpiresAt: number | null }` (base64 iv||ciphertext, identical scheme to sessions). `save` sets `expirationTtl: Math.max(60, Math.ceil((refreshExpiresAt - Date.now()) / 1000))` when `refreshExpiresAt != null`, else **no TTL**.

- [ ] **Step 1: Write the failing tests** — `mockKv()` copied from `routes/auth.test.ts:25-45` but `put(key, value, options?)` records `options` in the map entry (TTL assertions). `KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q='` (same fixture as session.test.ts). Test names + key assertions:
  - `round-trips a grant and never stores plaintext` — save pair with `refreshToken: 'ghr_dummy-r'`; raw KV value contains neither `gho_dummy-a` nor `ghr_dummy-r`; `load` returns the pair deep-equal.
  - `save sets the refresh-expiry TTL; non-expiring grant has none` — `refreshExpiresAt: Date.now() + 15897600_000` → captured `options.expirationTtl` ≈ 15897600 (±2); `refreshExpiresAt: null` → `options` undefined or no `expirationTtl`.
  - `load returns null for missing or corrupt records` — absent key; garbage JSON; ciphertext under a wrong key.
  - `resolve returns the cached token without fetching when fresh` — `accessExpiresAt: Date.now() + 3600_000`; stub fetch that throws if called; result = cached pair fields.
  - `resolve returns the cached token forever when non-expiring` — `accessExpiresAt: null`, `refreshToken: null`; fetch must not be called.
  - `resolve refreshes an expired grant and persists the rotated pair` — `accessExpiresAt: Date.now() - 1000`, refresh token present; mock fetch returns rotated pair (`gho_dummy-b` / `ghr_dummy-r2`, new expiries); result = new access token; `load` afterwards returns the rotated pair (KV updated).
  - `resolve refreshes inside the margin` — `accessExpiresAt: Date.now() + 60_000` (< 5 min) → refresh happens.
  - `recovers via grant re-read when a concurrent request already rotated it` — expired grant; mock fetch rejects with `RefreshTokenRejectedError`; **before** calling resolve, overwrite the KV grant with a rotated, unexpired pair (simulating the other request); result = the rotated token, no throw.
  - `rejected refresh with no rotation removes the grant and returns null` — fetch rejects `RefreshTokenRejectedError`, KV unchanged → result null; `load` afterwards null (key deleted).
  - `serves cached token on transient failure while still valid` — expiry inside margin, fetch rejects `Error('network')` → result = cached token.
  - `fails closed after hard expiry on transient failure` — `accessExpiresAt` past, fetch rejects `Error('network')` → null.
  - `missing grant returns null` — no KV record → null, fetch not called.
- [ ] **Step 2: Run, verify red** — `npx vitest run src/services/auth/githubGrant.test.ts`; expected: module-not-found / assertion failures.
- [ ] **Step 3: Implement** — `load`/`save`/`remove` mirror `ClientStore` crypto handling (fail closed to `null` on parse/decrypt error). `resolveFreshAccessToken` algorithm (the one non-obvious body — follow exactly):
  ```
  grant = await load(login); if (!grant) return null
  fresh = grant.accessExpiresAt == null || Date.now() < grant.accessExpiresAt - TOKEN_REFRESH_MARGIN_MS
  if (fresh) return { accessToken: grant.accessToken, accessExpiresAt: grant.accessExpiresAt }
  if (!grant.refreshToken) return null            // expired, nothing to refresh with
  try {
    pair = await refreshGitHubToken(oauth.clientId, oauth.clientSecret, grant.refreshToken)
    await save(login, pair)
    return { accessToken: pair.accessToken, accessExpiresAt: pair.accessExpiresAt }
  } catch (e) {
    reread = await load(login)                    // rotation race: someone else may have refreshed
    if (reread && reread.accessToken !== grant.accessToken &&
        (reread.accessExpiresAt == null || Date.now() < reread.accessExpiresAt))
      return { accessToken: reread.accessToken, accessExpiresAt: reread.accessExpiresAt }
    if (e instanceof RefreshTokenRejectedError) { await remove(login); return null }
    return Date.now() < (grant.accessExpiresAt ?? Infinity)
      ? { accessToken: grant.accessToken, accessExpiresAt: grant.accessExpiresAt }
      : null                                      // transient outage, hard expiry → fail closed
  }
  ```
- [ ] **Step 4: Run, verify green** — same command, all pass.
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): canonical rotating GitHub grant store with race-safe refresh"`

---

### Task 3: Session-layer refresh (`session.ts`)

**Files:**
- Modify: `packages/backend/src/services/auth/session.ts`
- Modify: `packages/backend/src/services/auth/index.ts` (re-exports: `GitHubGrantStore`, `TOKEN_REFRESH_MARGIN_MS`, `GitHubOAuthConfig`, `refreshGitHubToken`, `RefreshTokenRejectedError`, `GitHubTokenPair`)
- Test: `packages/backend/src/services/auth/session.test.ts`

**Interfaces:**
- Consumes: `GitHubGrantStore`, `GitHubOAuthConfig`, `TOKEN_REFRESH_MARGIN_MS` (Task 2).
- Produces:
  - `SessionRecord` gains `githubTokenExpiresAt?: number | null`
  - `constructor(kv: KVNamespace, encryptionKey: string, oauth?: GitHubOAuthConfig)` — **optional third arg**; absent → refresh disabled (all ~25 existing test construction sites and the purge middleware stay valid unchanged)
  - `createSession(githubToken: string, user: UserProfile, githubTokenExpiresAt?: number | null): Promise<string>`
  - `createClientSession(githubToken, user, repoLock, connectionOwner?, language?, clientId?, githubTokenExpiresAt?: number | null): Promise<string>` (new trailing optional param)
  - `getSession(token)` — unchanged signature; behavior extended below.

- [ ] **Step 1: Write the failing tests** — extend `session.test.ts`; its `mockKv()` lacks `list` (not needed here). Seed grants via `new GitHubGrantStore(kv, KEY).save('octocat', pair)`. Stub fetch as in Task 1. Test names + key assertions:
  - `createSession persists the expiry` — `createSession(TOKEN, USER, 123)` → stored JSON `githubTokenExpiresAt === 123`; `getSession` returns it.
  - `getSession leaves an unexpired token alone` — expiry `Date.now() + 3600_000`, grant seeded; fetch must not be called; token unchanged.
  - `getSession refreshes a near-expiry admin token and persists the cache` — expiry `Date.now() + 60_000`; grant for `USER.login` seeded expired-with-refresh; fetch returns rotated pair; result `githubToken` = new access token; stored session JSON carries the new expiry; grant in KV rotated.
  - `getSession returns null when expired and the grant is dead` — expiry past; grant seeded with `refreshToken: null` → null.
  - `getSession refreshes a client session through its connectionOwner grant` — `createClientSession(TOKEN, USER, repo, 'admin-login', 'fr', 'c1', expiry-near)`; grant seeded under `'admin-login'` (NOT `USER.login`); fetch called once; result token rotated.
  - `legacy sessions without expiry never refresh` — `createSession(TOKEN, USER)` (no expiry); fetch must not be called even with a grant seeded.
  - `no oauth config disables refresh` — `new SessionManager(kv, KEY)` (2 args), near-expiry session + grant → token unchanged, fetch not called.
  - `sliding renewal preserves githubTokenExpiresAt` — create with expiry far future; hand-edit stored `lastRefreshedAt` to `Date.now() - 25h` (read/parse/write via the raw store map); `getSession` → stored JSON still has the original `githubTokenExpiresAt` (the renewal block must copy the new field).
- [ ] **Step 2: Run, verify red** — `npx vitest run src/services/auth/session.test.ts`; expected failures on the new cases, existing 5 still green.
- [ ] **Step 3: Implement** —
  - Constructor: store `oauth`; always build `this.grants = new GitHubGrantStore(kv, encryptionKey)` (no KV traffic until used).
  - `createSessionWithKind`: trailing `githubTokenExpiresAt: number | null = null`; set on the record.
  - `getSession`, after the existing decrypt and **before** the sliding-renewal block:
    ```
    let rotated = false
    if (this.oauth && parsed.githubTokenExpiresAt != null &&
        Date.now() >= parsed.githubTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      const grantLogin = (parsed.kind ?? 'admin') === 'client' ? parsed.connectionOwner : parsed.user.login
      if (grantLogin) {
        const fresh = await this.grants.resolveFreshAccessToken(grantLogin, this.oauth)
        if (fresh) { parsed.githubToken = fresh.accessToken; parsed.githubTokenExpiresAt = fresh.accessExpiresAt; rotated = true }
        else if (Date.now() >= parsed.githubTokenExpiresAt) return null
        // else: margin-only, transient failure → keep serving the still-valid token
      }
    }
    ```
  - Sliding-renewal block: condition becomes `rotated || <existing interval check>`; the `refreshed` object **must include `githubTokenExpiresAt: parsed.githubTokenExpiresAt`** (it lists fields manually today — omission silently drops the expiry).
  - **Do not write back to client records from `getSession`.** The record's cached token is refreshed at client login (Task 5); the grant is the source of truth, so a stale record cache is harmless. Adding record write-back here would couple the session layer to `ClientStore` for no correctness gain.
- [ ] **Step 4: Run, verify green** — same command, all pass; root `npm run typecheck` 0 errors.
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): transparent token refresh in the session layer"`

---

### Task 4: Admin exchange — grant save + client re-anchor (`routes/auth.ts`)

**Files:**
- Modify: `packages/backend/src/routes/auth.ts` (`/exchange` ~L336-405; SessionManager construction L287)
- Test: `packages/backend/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `GitHubTokenPair` exchange (Task 1), `GitHubGrantStore` (Task 2), `createSession(..., expiry)` (Task 3), existing `ClientStore.list/update/encryptGitHubToken`.
- Produces: `/exchange` writes `github-grant:<user.login>` and re-anchors client records; later tasks rely on the grant existing after any admin login.

- [ ] **Step 1: Write the failing tests** — extend `auth.test.ts` (harness: `mockKv()` with `list`, `makeEnv`, fetch stub sequence: exchange response → `getUser` response). Seed a client record first via `ClientStore` (pattern at `auth.test.ts:318` / `clients.test.ts:90-140`): `createdBy: 'octocat'`, `requireApproval: true`, known `passwordHash`/`salt`. Test names + key assertions:
  - `exchange stores the grant and the session expiry` — exchange response includes `expires_in`/`refresh_token`/`refresh_token_expires_in`; after 200: KV `github-grant:octocat` exists, raw value contains no plaintext token; `getSession(cookieToken).githubTokenExpiresAt` ≈ now+28800_000.
  - `exchange re-anchors every access created by the admin, merge-safe` — two seeded records (`createdBy: 'octocat'`, one `requireApproval: true`, one `revoked: true`) + one `createdBy: 'someone-else'`; after exchange: both octocat records' `githubToken` ciphertext changed and `githubTokenExpiresAt` set; **byte-equal** on `passwordHash, salt, requireApproval, revoked, failedAttempts, lockedUntil, label, repo, createdBy, createdAt, language, lastUsedAt`; the someone-else record untouched (raw string equality).
  - `exchange with a non-expiring pair stores a grant without refresh token` — plain response; `GitHubGrantStore.load('octocat')` returns `refreshToken === null`, `accessExpiresAt === null`; re-anchor still sets `githubTokenExpiresAt: null` and fresh ciphertext.
  - `re-anchor failure does not break admin login` — stub `ClientStore.prototype.list` to reject once (`vi.spyOn … .mockRejectedValueOnce`); exchange still 200 with a live session.
- [ ] **Step 2: Run, verify red** — `npx vitest run src/routes/auth.test.ts`; new cases fail, existing stay green.
- [ ] **Step 3: Implement** —
  - L287: `new SessionManager(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env), { clientId: ctx.env.GITHUB_CLIENT_ID, clientSecret: ctx.env.GITHUB_CLIENT_SECRET })`.
  - `/exchange`: `const pair = await exchangeCodeForToken(...)`; `new GitHubClient(pair.accessToken)`; operator check unchanged; after `createSession(pair.accessToken, user, pair.accessExpiresAt)`:
    ```
    const key = await resolveEncryptionKey(ctx.env)
    await new GitHubGrantStore(ctx.env.SESSION_KV, key).save(user.login, pair)
    // best-effort re-anchor: revives legacy accesses without password changes
    try {
      const store = new ClientStore(ctx.env.SESSION_KV, key)
      const enc = await store.encryptGitHubToken(pair.accessToken)   // encrypt once, reuse
      for (const r of await store.list())
        if (r.createdBy === user.login)
          await store.update(r.clientId, { githubToken: enc, githubTokenExpiresAt: pair.accessExpiresAt })
    } catch (e) { console.error('Client re-anchor failed:', e instanceof Error ? e.message : e) }
    ```
    (Grant save happens **before** the try so a client-store failure never loses the grant; the catch must not swallow the grant save.)
- [ ] **Step 4: Run, verify green** — same command; root `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): store the admin grant and re-anchor client accesses on login"`

---

### Task 5: Client login — grant resolution + honest 403 (`routes/auth.ts`)

**Files:**
- Modify: `packages/backend/src/routes/auth.ts` (`/client-login` ~L484-504)
- Test: `packages/backend/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `GitHubGrantStore.resolveFreshAccessToken`, `TOKEN_REFRESH_MARGIN_MS` (Task 2); `createClientSession(..., githubTokenExpiresAt)` (Task 3); grant written by Task 4.
- Produces: client login that survives token expiry; 403 `backing_token_invalid` when the backing grant is unrecoverable (frontend maps it in Task 7).

- [ ] **Step 1: Write the failing tests** — seed records via `ClientStore.create` with a real `hashPassword` (pattern `auth.test.ts:555`); log in via `authRoutes.handle('/client-login', POST {clientId, password}, ctx)`; read the session cookie from `Set-Cookie` (existing tests show the pattern). Test names + key assertions:
  - `legacy record without expiry logs in unchanged` — record has no `githubTokenExpiresAt`; 200; fetch not called; session `githubTokenExpiresAt` null/absent.
  - `near-expiry record refreshes through the grant and updates its cache` — record expiry `Date.now() + 60_000`, `createdBy: 'octocat'`; grant seeded under `octocat` (expired + refresh token); fetch returns rotated pair; 200; record's `githubToken` ciphertext changed, `githubTokenExpiresAt` ≈ now+28800_000; `passwordHash`/`salt`/`requireApproval` unchanged; session token decrypts to the rotated access token.
  - `expired record with a dead grant returns 403 backing_token_invalid` — record expiry past; grant seeded `refreshToken: null`; response 403, `error.code === 'backing_token_invalid'` (assert **not** 401, **not** `invalid_credentials`).
  - `wrong password still 401 and increments failedAttempts` — regression guard with the new code path present.
  - `revoked access still 401 revoked` — regression guard.
- [ ] **Step 2: Run, verify red** — `npx vitest run src/routes/auth.test.ts`.
- [ ] **Step 3: Implement** — after the existing decrypt try/catch (keep its fail-closed 401):
  ```
  let tokenExpiresAt = record.githubTokenExpiresAt ?? null
  if (tokenExpiresAt != null && Date.now() >= tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    const grants = new GitHubGrantStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env))
    const fresh = await grants.resolveFreshAccessToken(record.createdBy,
      { clientId: ctx.env.GITHUB_CLIENT_ID, clientSecret: ctx.env.GITHUB_CLIENT_SECRET })
    if (fresh) {
      githubToken = fresh.accessToken; tokenExpiresAt = fresh.accessExpiresAt
      await store.update(clientId, { githubToken: await store.encryptGitHubToken(fresh.accessToken), githubTokenExpiresAt: fresh.accessExpiresAt })
    } else if (Date.now() >= tokenExpiresAt) {
      return jsonError('backing_token_invalid',
        'The GitHub connection behind this access has expired or been revoked. Ask the administrator to sign in again.', 403)
    }
  }
  ```
  Pass `tokenExpiresAt` as the new trailing arg to `createClientSession`. Rate limit, lockout, PBKDF2 burns, `lastUsedAt`, `reviewRequired` — unchanged.
- [ ] **Step 4: Run, verify green** — same command; then the **full backend suite** `npx vitest run` from `packages/backend` (all files, all green).
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): refresh client backing tokens at login with an honest 403"`

---

### Task 6: Wiring — construction sites + creation snapshot

**Files:**
- Modify: `packages/backend/src/routes/clients.ts` (L46 config; `requireAdmin` L52 return; creation record L126-140)
- Modify: `packages/backend/src/routes/repositories.ts:80`, `review.ts:30`, `deploy.ts:77-80`, `preview.ts:83-86` (config only)
- Modify: `packages/backend/src/services/auth/clients.ts` (`ClientRecord` field)
- Test: `packages/backend/src/routes/clients.test.ts`

**Interfaces:**
- Consumes: SessionManager optional config (Task 3); `SessionRecord.githubTokenExpiresAt`.
- Produces: `ClientRecord.githubTokenExpiresAt?: number | null`; newly created accesses snapshot the admin session's expiry; every session-reading route family refreshes transparently.

- [ ] **Step 1: Write the failing test** — `clients.test.ts`: `created access snapshots the admin session expiry` — create an admin session with `createSession(TOKEN, USER, 123456789)`; POST `/api/clients` create; stored record `githubTokenExpiresAt === 123456789`; `toAccess()` response shape unchanged (no new field leaked — assert the response JSON has exactly the existing keys).
- [ ] **Step 2: Run, verify red** — `npx vitest run src/routes/clients.test.ts`.
- [ ] **Step 3: Implement** —
  - `clients.ts` `ClientRecord`: add `githubTokenExpiresAt?: number | null` with a doc comment ("Cached access-token expiry; refresh chain lives in the admin grant, never here").
  - `requireAdmin`: add `githubTokenExpiresAt: number | null` to the return type annotation (L42) and return `githubTokenExpiresAt: session.githubTokenExpiresAt ?? null`; L46 SessionManager gets the config object.
  - Creation record: `githubTokenExpiresAt: admin.githubTokenExpiresAt`.
  - Four route files: add `{ clientId: ctx.env.GITHUB_CLIENT_ID, clientSecret: ctx.env.GITHUB_CLIENT_SECRET }` as the third SessionManager argument. `routes/index.ts:42` (purge) stays two-arg.
- [ ] **Step 4: Run, verify green** — `npx vitest run` full backend from `packages/backend`; root `npm run typecheck` 0 errors.
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): wire grant refresh through every session route and new accesses"`

---

### Task 7: Frontend — honest login error + message wording

**Files:**
- Modify: `packages/frontend/src/features/login/ClientLoginPage.tsx:141-146`
- Modify: `packages/frontend/src/i18n/messages.ts:579-580` (EN), `:938-939` (FR)
- Modify: `packages/frontend/src/features/client/ClientPagesPage.test.tsx:120` + every hit of `grep -rn "recreate your access" packages/frontend/src`
- Test: `packages/frontend/src/features/login/ClientLoginPage.test.tsx`

**Interfaces:**
- Consumes: backend 403 `backing_token_invalid` at `/client-login` (Task 5); existing `m.client.backingTokenInvalid`.
- Produces: login banner and pages/editor banner telling the client the admin must **sign in again** (re-anchor), not recreate the access.

- [ ] **Step 1: Write the failing test** — `ClientLoginPage.test.tsx`, mirroring the existing `shows the invalid message on wrong credentials` test (L84-102): `vi.mocked(clientLogin).mockRejectedValue(new ApiClientError(403, 'backing_token_invalid', 'nope'))`; test name `shows the backing-token message when the access GitHub connection is dead`; assert the banner text equals the **new EN string** below.
- [ ] **Step 2: Run, verify red** — from `packages/frontend`: `npx vitest run src/features/login/ClientLoginPage.test.tsx`; expected: shows "Invalid access ID or password." instead.
- [ ] **Step 3: Implement** —
  - `handleSubmit` catch: `if (err.code === 'revoked') … else if (err.code === 'backing_token_invalid') setError(m.client.backingTokenInvalid); else setError(m.login.invalid);`
  - EN `client.backingTokenInvalid` → `'There is a problem with this access — the GitHub connection behind it has expired or been revoked. Please ask the administrator to sign in again to restore it.'`
  - FR → idiomatic equivalent, e.g. `"Il y a un problème avec cet accès — la connexion GitHub associée a expiré ou a été révoquée. Demandez à l'administrateur de se reconnecter pour le rétablir."` (semantic parity required; exact wording executor's choice).
  - Update every test asserting the old string (grep command above; known hit `ClientPagesPage.test.tsx:120`).
- [ ] **Step 4: Run, verify green** — `npx vitest run` full frontend from `packages/frontend`; root `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): surface backing-token failures at client login and correct the recovery wording"`

---

### Task 8: Docs + full validation + bundle budget

**Files:**
- Modify: `docs/github-app.md` (new section under Option 1)

**Interfaces:**
- Consumes: everything above.
- Produces: documented behavior + a fully validated branch ready for review.

- [ ] **Step 1: Document** — add "### Expiring tokens and automatic refresh" to `docs/github-app.md` covering, in prose: OAuth apps created on/after 2026-08-14 default to 8-hour access tokens + 6-month refresh tokens (changelog link); the CMS stores one encrypted rotating grant per admin login (`github-grant:<login>`) and refreshes transparently at the session layer and client login; the first admin login after upgrading re-anchors all client accesses (no password changes); opt-out path (GitHub → Developer settings → OAuth Apps → app → Optional Features → expiring tokens) and its tradeoff (long-lived tokens; the CMS supports both modes); a dead refresh chain (6 months unused, grant revoked) requires the admin to sign in again — clients see the "ask the administrator" banner until then.
- [ ] **Step 2: Full validation** — at root: `npm run typecheck` (0 errors); `npm test` (backend + frontend, all green); `npm run build:single && npm run smoke:single && npm run dryrun:single` (ALL PASSED); `wc -c dist-single/nomad-cms.worker.js` ≤ **819200**.
- [ ] **Step 3: Fix any failure at its source** (no budget-driven deletion of behavior; if the bundle exceeds budget, report to the orchestrator — do not silently trim).
- [ ] **Step 4: Commit** — `git commit -am "docs: GitHub expiring-token behavior and the automatic refresh design"`

---

### Task 9: Live verification (owner: orchestrator + ravi — AFTER review gate)

**Not builder work.** Gated on the orchestrator's fresh-context review of the branch diff and ravi's approval.

- [ ] Merge `feat/github-token-refresh` → `main`, push, CI green, deploy (`packages/backend`, built frontend assets), confirm the new version serves.
- [ ] ravi signs in as admin (GitHub OAuth). Verify in production KV (`3800adeb915644db964c0ad338f411a8`): `github-grant:IsseyShiitake` exists; both client records now carry `githubTokenExpiresAt`; `client:elisabeth-jrfm` still `requireApproval: true`, `passwordHash`/`salt` unchanged.
- [ ] Elisabeth signs in with her **existing** password → pages load, no error banner, FR review banner present.
- [ ] Save an edit → PR appears on `cms/elisabeth-jrfm` in Pending reviews; `main` untouched; approve → publish (or reject → branch deleted).
- [ ] Next-day check: admin session still alive past 8 hours without re-login; client save still works.
- [ ] Append `log.md` entry with the verification evidence.

---

## Execution handoff

Recommended: **builder executes inline** (executing-plans) on the feature branch — the tasks share tightly coupled interfaces (`GitHubTokenPair` → grant store → session → routes) and one builder context holds them cheapest; the orchestrator then runs a **fresh-context review of the full branch diff** (requesting-code-review) before any merge/push/deploy. Per-task dispatch is the fallback if the builder's context degrades.

**Before the builder starts:** ravi/orchestrator commits the pending cookie/CSP set to `main` (Global Constraints precondition).