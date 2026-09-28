# Deployment Guide

This guide walks through deploying the Static Site CMS to production as a single Cloudflare Worker that serves both the API and the frontend's static assets.

## Architecture Overview

| Component | Hosting | Purpose |
| --- | --- | --- |
| `packages/backend` | Cloudflare Worker | OAuth, GitHub proxy, image proxy, settings |
| `packages/frontend` | Static assets served by the same Worker | React SPA UI |
| `packages/shared` | npm workspace | Shared types (build-time only) |

The frontend is a static SPA served by the same Worker that handles `/api/*`. In production the whole site lives on one origin (e.g. `https://nomad-cms.isseyshiitake.workers.dev`), so API calls are same-origin by default and no `VITE_API_BASE_URL` is needed unless you deliberately split domains.

---

## Prerequisites

- A Cloudflare account with a zone (domain) you control.
- Node.js ^20.19.0 or >=22.12.0 and npm.
- A GitHub account with a GitHub OAuth App (see `docs/github-app.md`).

---

## 1. Create the GitHub OAuth App

Follow `docs/github-app.md` to create the OAuth App. Record the **Client ID** (public) and **Client Secret** (secret).

---

## 2. Deploy the Backend Worker

### 2.1 Create the KV namespace

```bash
cd packages/backend
npx wrangler kv namespace create SESSIONS_NOMAD
```

Copy the returned namespace **id** into `packages/backend/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SESSION_KV"
id = "<your-namespace-id>"
```

### 2.2 Configure environment variables

Edit `packages/backend/wrangler.toml`:

- Set `GITHUB_CLIENT_ID` to your OAuth App's public Client ID.
- Set `GITHUB_REDIRECT_URI` to the production frontend URL, e.g. `https://cms.example.com/auth/callback`.
- Set `OPERATOR_LOGIN` to **your own GitHub login** before the first sign-in. Operator pinning allows exactly one GitHub login to hold the admin role; every other login is rejected with `403 instance_locked`. Leaving it empty means the FIRST GitHub login claims the slot (write-once) — set it explicitly to remove that race.

### 2.3 Set secrets

Never commit secrets. Set them via `wrangler secret put`:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_ENCRYPTION_KEY
```

`GITHUB_CLIENT_SECRET` is required. `SESSION_ENCRYPTION_KEY` is strongly
recommended but technically optional — when absent, the Worker
self-provisions a key into KV on first boot (the key then lives in the
same namespace as the data it encrypts; acceptable for a single-tenant
Worker whose only KV reader is the Worker itself). It is the AES-256 key
(base64 or hex of 32 bytes) used to encrypt GitHub tokens and platform
credentials at rest in KV; generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2.4 Deploy

```bash
npm run deploy
```

The Worker will be available at `https://<your-worker>.<your-subdomain>.workers.dev` (for this project: `https://nomad-cms.isseyshiitake.workers.dev`).

> **Note:** If you use a custom domain for the Worker, add a route in the Cloudflare dashboard (e.g. `api.cms.example.com/*`) and set `VITE_API_BASE_URL` accordingly.

---

## 3. Configure the Frontend Build and Deploy Everything

### 3.1 Set `.env.production` (optional)

By default the frontend builds for the same origin as the Worker and needs no extra configuration. To customize build-time values, create a `.env.production` in `packages/frontend`:

```bash
VITE_API_BASE_URL=
VITE_APP_NAME=Nomad CMS
```

`VITE_API_BASE_URL` stays empty for this single-Worker deployment (the
Worker serves `/api/*` itself). OAuth values are not frontend configuration —
the Worker builds the authorize URL server-side.

> All `VITE_*` values are public by design. Never put secrets here.

### 3.2 Deploy

From the repo root:

```bash
npm run deploy
```

---

## 4. Wire Up OAuth Callback

Register the production callback URL on the GitHub OAuth App — exactly the
value of `GITHUB_REDIRECT_URI` under `[vars]` in `packages/backend/wrangler.toml`:

- `https://<your-worker>.<your-subdomain>.workers.dev/auth/callback`

GitHub OAuth Apps accept a single callback URL. For local development,
create a second OAuth App with the `http://localhost:5173/auth/callback`
callback and point `.dev.vars` / `.env.local` at it (see
`docs/github-app.md` — the authorization URL is built server-side by the
Worker; the frontend env values are not used).

---

## 5. Connect Hosting Platforms (optional)

To publish the sites this CMS edits to Cloudflare Pages or Vercel, connect
your platform accounts in **Settings → Hosting platforms**. No Worker
configuration changes are needed — tokens are stored encrypted in the
existing KV namespace. See `docs/hosting-platforms.md`.

---

## 6. Verify

1. Visit `https://cms.example.com`.
2. Click **Sign in with GitHub**.
3. Complete the OAuth flow; you should be redirected back and authenticated.
4. Select a repository, open a page, make an edit, and save.
5. With a platform connected, the save also triggers a production
   deployment; the pages list shows its build state and live URL.

---

## Common Issues

| Issue | Fix |
| --- | --- |
| OAuth redirect URI mismatch | Ensure the callback URL matches exactly in the GitHub App and `GITHUB_REDIRECT_URI`. |
| Frontend not loading | The same Worker serves the frontend from `packages/frontend/dist` static assets; make sure the full build ran (`npm run build`) before `npm run deploy`. |
| CORS errors | By default the API and the frontend share one origin, so no CORS configuration is needed. Only split-domain deployments (frontend on a different origin than the API) require `ALLOWED_ORIGINS` (see `docs/cloudflare-worker.md`). |
| KV namespace not found | Ensure the namespace id in `wrangler.toml` is correct and the namespace was created in the same account/region as the Worker. |