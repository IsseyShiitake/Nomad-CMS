# GitHub App Configuration

The CMS authenticates with GitHub via OAuth. This document covers two approaches:

1. **GitHub OAuth App** — the current, recommended setup (simplest, works locally and in production).
2. **GitHub App** — a more advanced option that supports fine-grained permissions and per-installation webhooks. The architecture is designed so migrating later only changes the backend token-acquisition code, not the route or UI contracts.

> **Deploying the release bundle?** (`nomad-cms.worker.js` + `wrangler.toml` +
> `setup.mjs` from the Releases page.) You still create exactly this OAuth App —
> the setup script automates the steps below: it prints the exact callback URL
> for your deployed Worker, opens the create-app page, takes the Client ID into
> `wrangler.toml`, and pipes the secret into
> `wrangler secret put GITHUB_CLIENT_SECRET` without writing it anywhere. See
> `docs/self-hosting.md`. The manual wiring table below applies unchanged —
> only the file paths differ (`wrangler.toml` sits beside the Worker in your
> bundle folder).

---

## Option 1: GitHub OAuth App (current)

### Create the OAuth App

1. Go to **https://github.com/settings/developers** → **New OAuth App**.
2. Fill in the details:
   - **Application name:** `Nomad CMS`
   - **Homepage URL:** `https://cms.example.com` (or `http://localhost:5173` for development)
   - **Authorization callback URL:** `https://cms.example.com/auth/callback` (or `http://localhost:5173/auth/callback` for development)
3. Click **Register application**.
4. Record the **Client ID** — this is public by design; it lives in the backend as the `GITHUB_CLIENT_ID` var in `packages/backend/wrangler.toml` `[vars]`. The frontend needs **no** OAuth configuration.
5. Click **Generate a new client secret**. Record it — this is secret, never commit it.

### Required scopes

- **`repo`** — the CMS reads/writes HTML files, uploads images, and discovers repository structure.

The scope is requested by the Worker when it builds the GitHub authorize URL
(`packages/backend/src/routes/auth.ts`, `GET /api/auth/authorize`); the
frontend only redirects the browser to the returned URL and never constructs
OAuth URLs itself. The backend exchanges the authorization code with the
client secret.

### Wire the credentials

| Value | Where it lives | Type |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | `packages/backend/wrangler.toml` (`[vars]`) | Public |
| `GITHUB_CLIENT_SECRET` | `wrangler secret put GITHUB_CLIENT_SECRET` | Secret |

The backend `GITHUB_REDIRECT_URI` var (`packages/backend/wrangler.toml`)
carries the OAuth callback registered on the GitHub app; the token exchange
sends the same value (GitHub rejects a mismatch with
`redirect_uri_mismatch`). The frontend sends the code to the backend; the
backend exchanges it with the client secret.

### Development setup

1. Create a second OAuth App (or reuse the same app with a different callback) for local development:
   - **Homepage URL:** `http://localhost:5173`
   - **Authorization callback URL:** `http://localhost:5173/auth/callback`
2. Set the values on the backend only: `GITHUB_CLIENT_ID` and `GITHUB_REDIRECT_URI` (the localhost callback) in `packages/backend/wrangler.toml` `[vars]`, and `GITHUB_CLIENT_SECRET` in `packages/backend/.dev.vars` (gitignored).

---

## Option 2: GitHub App (advanced / future)

A GitHub App allows fine-grained permissions and installation-level access. The current architecture isolates all GitHub token acquisition in the backend `services/auth/oauth.ts` + `services/github/client.ts`, so migrating requires:

1. Creating a GitHub App at **https://github.com/settings/apps/new**.
2. Setting **Permissions**:
   - **Contents: Read & write** — needed to read/commit HTML and images.
   - **Metadata: Read-only** — needed to list repositories and branches.
3. Configuring **Webhooks** (optional, for future live preview/deploy hooks).
4. Generating a **Private Key** — this replaces the OAuth client secret.
5. Implementing a new token-acquisition function (e.g. GitHub App installation token exchange via JWT) in `packages/backend/src/services/auth/oauth.ts`.
6. Updating `packages/backend/src/env.ts` + `wrangler.toml` to bind the new secrets (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`).

The frontend and route contracts remain unchanged because they only ever talk to the backend's `/api/auth/*` endpoints.

---

## Security notes

- The GitHub **client secret** (or GitHub App private key) must never reach the frontend. It is only bound to the Worker.
- The `<Client ID>` is public by design.
- Scopes are the minimal set required; do not request `admin:org` or similar unless needed.
- Rotate the client secret periodically via the GitHub developer settings.