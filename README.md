# Nomad CMS

[![CI](https://github.com/IsseyShiitake/Nomad-CMS/actions/workflows/ci.yml/badge.svg)](https://github.com/IsseyShiitake/Nomad-CMS/actions/workflows/ci.yml)

A lightweight CMS for editing static HTML websites stored in GitHub repositories. The whole CMS — API and UI — is a single Cloudflare Worker that you deploy on your own Cloudflare account. Sign in with GitHub, edit your pages in a visual editor, and every save is a commit; optionally trigger Cloudflare Pages / Vercel production deployments on publish.

![Browsing a repository's pages in Nomad CMS](docs/assets/edit.png)

## Screenshots

| | |
| --- | --- |
| ![Welcome intro](docs/assets/welcome.png) | ![Editable elements highlighted as beacons](docs/assets/beacons.png) |
| ![Sign-in screen](docs/assets/signin.png) | ![Login — light theme](docs/assets/login-light.png) |

![Login — dark theme](docs/assets/login-dark.png)

## Features

- **GitHub OAuth sign-in** — authenticate with your GitHub account.
- **Repository browser** — list, search, and filter your repositories.
- **HTML page discovery** — find all HTML files in a repository.
- **DOM-based HTML scanner** — detect editable elements (h1, h2, p, img, `data-editable`).
- **In-browser editor** — edit text, replace images, delete/insert elements with a live preview.
- **Save & commit** — commit changes back to GitHub with a clear message.
- **Image upload** — upload local images and reference them in your pages.
- **Merge conflict handling** — surfaces conflicts so you can reload and re-apply.
- **Publish to Cloudflare Pages & Vercel** — connect your platform accounts, trigger production deployments after each save, and follow build status to the live URL. Vercel projects without a Git repository are editable directly.
- **Client accesses** — hand out restricted logins (locked to one repository, with their own UI language) to other people.
- **Security-first** — GitHub and platform credentials never reach the frontend.

## Run your own instance

Nomad CMS is single-tenant by design: you deploy your own Worker, register your own GitHub OAuth app, and exactly one GitHub login — yours — holds the admin role. Nobody shares your instance, and credentials never leave your Cloudflare account.

**What you need**

- a free Cloudflare account (Workers + Workers KV),
- a GitHub account,
- Node.js 20 or newer with npm (`node --version` to check).

### The short way — the setup script

Download the release bundle from the [Releases page](https://github.com/IsseyShiitake/Nomad-CMS/releases) — three files: `nomad-cms.worker.js`, `wrangler.toml`, `setup.mjs` — put them in one empty folder, then:

```bash
node setup.mjs
```

The script does everything else on your Cloudflare account and asks you only for:

1. a **Worker name** (becomes `https://<name>.<your-subdomain>.workers.dev`),
2. your **GitHub username** (that login becomes the instance's only admin),
3. one **browser step**: it opens GitHub's "new OAuth app" page — you fill in the name, paste the callback URL the script shows you, and copy back the **Client ID** and **Client secret**. The secret is typed hidden and piped straight into `wrangler secret put` — it is never written to any file.

When it finishes it prints your CMS URL. Open it, sign in with GitHub, and start editing. Your sites keep building on their existing platform (GitHub Pages / Cloudflare Pages / Vercel) from the commits the CMS pushes — no platform connection is required to edit.

Setup takes about ten minutes. The full walkthrough, including every prompt explained, is in [`docs/self-hosting.md`](docs/self-hosting.md).

### The manual way — no installer

For people who prefer to do every step by hand:

1. Download the release bundle (above) into one folder.
2. Create the KV namespaces and note their ids:
   ```
   npx wrangler kv namespace create my-site-SESSIONS
   npx wrangler kv namespace create my-site-SESSIONS-preview
   ```
3. Edit `wrangler.toml`: set `name`, paste the two namespace ids into the `[[kv_namespaces]]` block, set `GITHUB_REDIRECT_URI = "https://<name>.<your-subdomain>.workers.dev/auth/callback"` and `OPERATOR_LOGIN` to your GitHub login.
4. Deploy with placeholder vars:
   ```
   npx wrangler deploy
   ```
5. Create a GitHub OAuth app at https://github.com/settings/applications/new with the callback `https://<name>.<your-subdomain>.workers.dev/auth/callback`.
6. Put the app's client id in `wrangler.toml` (`GITHUB_CLIENT_ID`) and bind the secret:
   ```
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
7. Deploy again and open your Worker URL.

Every slot in `wrangler.toml` is commented. `docs/deployment.md` covers the same flow for a source checkout.

## Updating your instance

Your `wrangler.toml` is your file — it holds your Worker name, KV ids, and client id, and releases never overwrite it (keep the folder; back it up). To update the CMS: download the new `nomad-cms.worker.js` from the Releases page, replace the old one in your bundle folder, and run `npx wrangler deploy`. All data — sessions, client accesses, platform connections — lives in your KV namespace and survives updates.

## Troubleshooting

| Symptom | What it means | Fix |
| --- | --- | --- |
| GitHub returns `redirect_uri_mismatch` | The callback registered on your GitHub OAuth app doesn't exactly match `GITHUB_REDIRECT_URI` in `wrangler.toml` | Make both `https://<name>.<your-subdomain>.workers.dev/auth/callback`, character for character |
| "Sign in" ends in `instance_locked` | This instance's operator slot is claimed by another GitHub login — it is write-once by design | If you own the instance: set `OPERATOR_LOGIN` in `wrangler.toml` to your login and redeploy. If you don't: you're on someone else's instance |
| Deploy fails: KV namespace title already in use | A namespace with that exact title already exists on the account (the setup script names them `<worker>-SESSIONS` to avoid this) | Re-run the script — it reuses existing namespaces — or pick another Worker name |
| Setup prints "could not read the URL from wrangler's output" | The deploy worked but the URL line wasn't parseable | Paste the printed `https://…workers.dev` URL when the script asks |
| `429 rate_limited` on sign-in | Too many sign-in attempts from your IP in one hour (built-in abuse guard) | Wait a few minutes and try again |
| Everything 404s after a deploy | The Worker name in `wrangler.toml` doesn't match the URL you're visiting | Check `name` in the toml and redeploy |

## FAQ

**Does my site need to be on Cloudflare or Vercel?** No. Editing only needs the site's HTML in a GitHub repository. Publishing integrations are optional extras configured inside the CMS (Settings → Hosting platforms).

**Who can sign in?** Exactly one GitHub login (the operator). You can hand out restricted **client accesses** — password logins locked to a single repository — to other people from inside the CMS.

**Where do my credentials live?** Your GitHub OAuth secret is a Worker secret; access and platform tokens are encrypted at rest in your own KV namespace. Nothing is stored by Nomad CMS's authors — the authors can't reach your instance at all.

**Can I run two instances on one account?** Yes — different Worker names. The setup script namespaces the KV storage per instance automatically.

**How much does it cost?** The free tiers of Cloudflare Workers/KV are enough for personal use.

## Security model

- **GitHub credentials never reach the frontend.** The Cloudflare Worker is the only component that holds the GitHub OAuth client secret. The session token is carried in an **HttpOnly cookie** (never readable by JavaScript); the frontend only ever sees the user's public profile.
- **GitHub and platform API tokens are encrypted at rest** in the Worker's KV namespace (`SESSION_ENCRYPTION_KEY`), so namespace read access alone does not expose them.
- **Secrets are never committed.** The setup script pipes the client secret straight into `wrangler secret put`. Local development secrets live in `packages/backend/.dev.vars` (gitignored).
- **Security headers + CORS + CSRF** are applied to every API response; the frontend ships a CSP meta tag, and the single-file bundle ports those headers 1:1.
- **Operator pinning:** only `OPERATOR_LOGIN` may hold the admin role; every other GitHub login is rejected with `403 instance_locked`.

## Local development

### Prerequisites

- Node.js ^20.19.0 or >=22.12.0
- npm

### Install

```bash
npm install
```

### Configure environment

**Frontend** — copy `packages/frontend/.env.example` to `packages/frontend/.env.local` and fill in values (defaults work as-is for local development).

**Backend** — copy `packages/backend/.dev.vars.example` to `packages/backend/.dev.vars` and fill in the secret values, plus the two local-dev var overrides for your OAuth app (see below).

### Run locally

```bash
# Terminal 1 — backend Worker
npm run dev:backend

# Terminal 2 — frontend
npm run dev:frontend
```

The frontend runs at `http://localhost:5173` and proxies `/api` requests to the Worker at `http://localhost:8787`.

### GitHub OAuth setup for local development

1. Create a GitHub OAuth app at https://github.com/settings/developers
   - **Homepage URL**: `http://localhost:5173`
   - **Authorization callback URL**: `http://localhost:5173/auth/callback`
   - Scope: `repo` (requested by the Worker when it builds the authorize URL)
2. In `packages/backend/.dev.vars`, set:
   - `GITHUB_CLIENT_SECRET` — the app's client secret,
   - `GITHUB_CLIENT_ID` and `GITHUB_REDIRECT_URI=http://localhost:5173/auth/callback` — these override the production `[vars]` from `wrangler.toml` during `wrangler dev`, pointing local login at your own app.
3. Create the KV namespace and put its id in `wrangler.toml`:
   ```
   npx wrangler kv namespace create SESSIONS_NOMAD
   ```
4. Set `OPERATOR_LOGIN` in `packages/backend/wrangler.toml` to your GitHub login (empty = the first sign-in claims the slot).
5. Start both dev servers and click **Sign in with GitHub** — the Worker builds the authorize URL server-side; no frontend OAuth configuration is needed.

See `docs/github-app.md` for full details, including migrating to a GitHub App.

### Build, typecheck, test

```bash
npm run build
npm run typecheck
npm test
npm run build:single   # single-file Worker bundle → dist-single/ (release artifact)
```

## Project structure

This project is a **monorepo** with three packages:

| Package | Description |
| --- | --- |
| `packages/frontend` | React + TypeScript + Vite UI |
| `packages/backend` | Cloudflare Worker (TypeScript) API |
| `packages/shared` | Shared domain types used by both |

**Frontend** (`packages/frontend/src`):

- `api/` — typed HTTP client and endpoint modules
- `config/` — environment-derived configuration
- `services/` — domain services:
  - `htmlParser/` — DOM-based HTML parser (never regex)
  - `auth/` — session management (React context)
  - `editorState/` — editor state controller
  - `images/` — image manager
  - `publish/` — deployment trigger + build-status polling
- `features/` — feature pages (repositories, pages, editor, settings, publish panel)
- `ui/` — reusable layout and components

**Backend** (`packages/backend/src`):

- `index.ts` — Worker entry point
- `index-single.ts` — single-file bundle entry (embedded assets instead of the ASSETS binding)
- `single/` — embedded-asset serving for the single-file build
- `env.ts` — typed Worker environment
- `core/` — HTTP helpers, security headers, rate limiting
- `routes/` — API route modules (auth, repositories, deploy, preview, clients)
- `services/auth/` — OAuth code exchange + session manager
- `services/github/` — GitHub API client
- `services/deploy/` — Cloudflare Pages & Vercel clients, connection store, direct-storage adapter

## Documentation

- `docs/self-hosting.md` — full self-hosting guide (script + manual walkthroughs)
- `docs/deployment.md` — end-to-end production deployment from source
- `docs/hosting-platforms.md` — Cloudflare Pages & Vercel publishing
- `docs/github-app.md` — GitHub OAuth App configuration
- `docs/cloudflare-worker.md` — Cloudflare Worker configuration
- `docs/static-assets.md` — static assets configuration
- `docs/production-checklist.md` — pre/post-deploy checklist
- `docs/tutorial-beginners.md` — beginner's tutorial (install, run, first edit)
- `docs/architecture.md` — architecture and key design decisions

## License

[MIT](LICENSE) © 2026 IsseyShiitake
