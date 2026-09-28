# Hosting Platforms (Cloudflare Pages & Vercel)

The CMS publishes the sites it edits to hosting platforms. Editing still
happens against the source of truth — a GitHub repository for Git-connected
projects, or the platform itself for Vercel **direct** projects (no Git
repository) — and publishing triggers a production deployment.

Two platforms are supported:

| Platform | Git-connected projects | Direct-upload projects (no Git) |
| --- | --- | --- |
| Cloudflare Pages | ✅ edit via GitHub, publish = rebuild branch HEAD | ❌ (no file API) |
| Vercel | ✅ edit via GitHub, publish = deploy from Git ref | ✅ files live only on Vercel |

## Security model

Per-administrator connections, mirroring the GitHub OAuth model:

- Each administrator connects their **own** Cloudflare/Vercel account in
  **Settings → Hosting platforms**. Platform API tokens are stored in the
  Worker's KV namespace, **AES-GCM encrypted** with `SESSION_ENCRYPTION_KEY`
  (the same key and scheme as session GitHub tokens), keyed by the admin's
  GitHub login (`deploy:<login>:<platform>`).
- Tokens never reach the frontend. The Settings UI sends a token once on
  connect; it is never rendered back. Connection records expose only the
  platform, account display name, and usage state.
- Tokens are verified at connect time (the platform must accept them before
  anything is stored).
- **Publishing is admin-only.** Client sessions do see read-only deployment
  state and the live URL for their locked repository — deploy links and
  status resolve through the creating administrator's platform connections
  (the session's `connectionOwner`) — but they cannot publish or manage
  connections; the backend enforces this on every publish call.
- All `/api/deploy/*` routes pass through the same CSRF + security-header
  middleware as every other API route.

## How publishing works

1. **Connect** the platform in Settings.
2. The CMS lists the platform's projects and matches each one to a GitHub
   repository by its connected-repo metadata (`owner/name`). No manual
   linking is needed.
3. After **Save** in the editor (admin session), or via **Publish** on the
   pages list, the CMS triggers a production deployment for every linked
   project:
   - **Cloudflare Pages** — `POST /accounts/{id}/pages/projects/{name}/deployments`
     (rebuilds the production branch HEAD).
   - **Vercel** — `POST /v13/deployments` with a `gitSource` built from the
     repository's real default branch (looked up per publish).
4. The publish panel polls deployment state (`queued → building → success`)
   and surfaces the live URL.

The editor's auto-publish is best-effort: a failed publish never blocks a
completed commit, and the pages-list panel shows full state.

## Vercel direct projects

Vercel projects with **no Git repository** appear for admins as virtual
repositories under the owner `vercel` (e.g. `vercel/my-site`). They flow
through the same editor end to end:

- **List / contents / pages / images** are read from the latest production
  deployment's file tree (`GET /v6/deployments/{id}/files`).
- **Page content** is read by file uid (`GET /v8/deployments/{id}/files/{uid}`).
- **Saving** computes the changed file's SHA-1, uploads it to Vercel's
  content-addressed store (`POST /v2/files`), and creates a new production
  deployment whose manifest references **every** project file — unchanged
  files carry over by path, so only the changed bytes are uploaded.
  Deployments are immutable: concurrency is last-write-wins (there is no
  merge-conflict analogue).

Client-access sessions never see the virtual namespace — direct projects
belong to the administrator's platform connection.

## Setup

### Cloudflare Pages

1. Create an API token at <https://dash.cloudflare.com/?to=/:account/api-tokens>
   with the **Cloudflare Pages: Edit** permission.
2. Copy your **account ID** (dashboard → Workers & Pages → right sidebar).
3. In the CMS: Settings → Hosting platforms → Cloudflare Pages → paste the
   token and the account ID → **Connect**.

### Vercel

1. Create a token at <https://vercel.com/account/tokens>
   (scope it to your team when using one).
2. In the CMS: Settings → Hosting platforms → Vercel → paste the token
   (team ID optional — the token's own account is used otherwise) →
   **Connect**.

## Platform OAuth login (optional)

Besides pasting API tokens, administrators can connect platforms with an
OAuth login. **Log in with Cloudflare / Vercel** buttons appear in
**Settings → Hosting platforms** and on the login screen; a platform whose
client id var is empty simply has no button (the login is hidden, not
broken). From the login screen the flow signs you in with GitHub first and
only then continues to the platform's authorize URL.

The flow mirrors the GitHub login: the Worker builds the authorize URL
(`GET /api/auth/platform/:platform/authorize`, admin session required,
PKCE where the platform mandates it) and exchanges the returned code into
the admin's stored connection (`POST /api/auth/platform/:platform/exchange`).

Configuration lives in `packages/backend/wrangler.toml`: public client ids
and redirect URIs as `[vars]` (`CLOUDFLARE_OAUTH_CLIENT_ID` /
`CLOUDFLARE_OAUTH_REDIRECT_URI`, `VERCEL_OAUTH_CLIENT_ID` /
`VERCEL_OAUTH_REDIRECT_URI`), and the matching secrets via
`wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET` /
`wrangler secret put VERCEL_OAUTH_CLIENT_SECRET` when enabled.

> **Vercel caveat:** Vercel OAuth tokens cannot drive deployment API calls
> yet — pasting an API token (above) remains the functional Vercel path.

## API surface (`/api/deploy/*`)

| Method | Path | Purpose | Access |
| --- | --- | --- | --- |
| GET | `/connections` | List the admin's platform connections | admin |
| POST | `/connections/:platform` | Connect / replace a token (verified first) | admin |
| DELETE | `/connections/:platform` | Disconnect | admin |
| GET | `/projects` | List all connected platforms' projects | admin |
| GET | `/links/:owner/:repo` | Platform projects linked to a repository | any session (repo-lock enforced) |
| POST | `/links/:owner/:repo/publish` | Trigger production deployments | admin |
| GET | `/links/:owner/:repo/status` | Latest deployment summaries | any session (repo-lock enforced) |

Errors map consistently: a rejected platform token becomes
`401 platform_token_invalid` (the UI shows a reconnect hint), rate limits
surface as `429` with `Retry-After`, and upstream 5xx collapse into `502`.

The preview proxy accepts `https://*.pages.dev` and `https://*.vercel.app`
URLs in addition to `*.github.io`, so repository tiles miniature
platform-hosted sites correctly.

## Environment

Platform API tokens live in KV, encrypted with the existing
`SESSION_ENCRYPTION_KEY` — no new Worker secret is needed for token-paste
connections. The optional platform OAuth login (above) does add
configuration: client ids and redirect URIs as `[vars]` in
`packages/backend/wrangler.toml`, and the matching client secrets via
`wrangler secret put` when a platform's login is enabled.
