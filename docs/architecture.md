# Architecture

## Overview

The CMS is a monorepo with three packages. The frontend is a React SPA; the backend is a Cloudflare Worker; a shared package holds the domain types both sides agree on.

```
┌─────────────────────────────────────────────┐
│  One Cloudflare Worker (nomad-cms)          │
│                                             │
│  /api/* served by the Worker script:        │
│    - Auth (OAuth)                           │
│    - Repositories (GitHub proxy)            │
│    - Clients                                │
│    - Deploy                                 │
│    - Preview                                │
│    - KV storage                             │
│                                             │
│  Everything else served from static assets  │
│  (packages/frontend/dist, SPA fallback):    │
│    Frontend (React SPA)                     │
│    - UI                                     │
│    - HTML parser                            │
│    - Auth context                           │
│    - Editor state                           │
│    - Images                                 │
│    - Settings                               │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
               ┌──────────────┐
               │  GitHub API  │
               └──────────────┘
```

## Key decisions

### 1. Monorepo with npm workspaces

All three packages live in one repository. This keeps the shared types in sync, simplifies local development, and allows a single `npm install` and `npm run build`.

### 2. Shared types package

`@cms/shared` defines the domain model (repositories, pages, auth, images, clients, deploy) and the API contract. Both the frontend and backend import from it, so the wire format cannot drift. It also exports shared utilities such as `encodePath` for consistent URL path encoding.

### 3. Backend as the only credential holder

Per project priority #4, GitHub credentials never reach the frontend. The Worker:

- Holds the GitHub OAuth client secret as a secret.
- Exchanges OAuth codes for GitHub tokens.
- Proxies all GitHub API calls.
- Issues opaque session tokens to the frontend.

The frontend never sees the session token. The Worker sets it as an HttpOnly cookie that the browser sends automatically on credentialed requests; the frontend tracks only the public user profile.

### 4. DOM-based HTML parsing, never regex

Per project priority #3, the HTML parser module uses the browser's `DOMParser` and DOM APIs. Regex is never used to modify HTML because it cannot reliably handle the full HTML grammar.

### 5. Interface-first service modules

Each domain service (GitHub, HTML parser, auth, editor state, images, publish) defines a TypeScript interface. Implementations are provided as milestones land. This lets feature pages be built against stable contracts without waiting for the implementation.

### 6. Feature-based frontend organization

The frontend is organized by feature (`features/`) with shared UI in `ui/` and domain services in `services/`. This keeps related code together and makes it easy to add or remove features.

### 7. Lazy-loaded routes

Feature pages are lazy-loaded with `React.lazy` + `Suspense` so the initial bundle stays small and each page loads on demand.

### 8. Security headers on every response

The backend applies `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a restrictive `Content-Security-Policy` to every API response. The frontend ships a CSP meta tag and a `_headers` file that Workers Static Assets serves with the assets (`_redirects` was deleted — the SPA fallback is native via `not_found_handling`).

## Frontend module responsibilities

| Module | Responsibility |
| --- | --- |
| `api/` | Typed HTTP client; all backend communication |
| `config/` | Environment-derived public configuration |
| `services/htmlParser/` | DOM-based scanner + parser (Milestones 3 & 4) |
| `services/auth/` | Session management via React context |
| `services/editorState/` | Editor controller with save/undo (Milestones 4 & 5) |
| `services/images/` | Image manager (Milestone 5) |
| `features/` | Feature pages: repositories, pages, editor, settings, OAuth callback |
| `ui/` | Reusable layout and components |

## Backend module responsibilities

| Module | Responsibility |
| --- | --- |
| `index.ts` | Worker entry point; routes `/api/*` |
| `routes/` | API route modules: auth, repositories, clients, deploy, preview |
| `services/auth/` | OAuth code exchange + KV-backed session manager |
| `services/github/` | GitHub REST API client with optimistic concurrency |
| `services/deploy/` | Cloudflare Pages & Vercel clients, encrypted connection store, Vercel direct-storage adapter |

## Security

- Secrets are bound to the Worker only.
- The frontend `.env.example` contains only public values.
- The backend `.dev.vars.example` documents secret names; real values are gitignored.
- Production secrets are set via `wrangler secret put`.
- Every API response includes security headers.
- The frontend ships a CSP meta tag and a `_headers` file served by Workers Static Assets (`_redirects` was deleted — SPA fallback is native).

## Development workflow

1. Start the backend: `npm run dev:backend` (port 8787).
2. Start the frontend: `npm run dev:frontend` (port 5173).
3. The Vite dev server proxies `/api` to the Worker, so no CORS config is needed locally.

## Build pipeline

- `npm run build` builds all packages.
- `npm run typecheck` type-checks all packages.
- `npm test --workspace @cms/frontend` runs the unit tests.
- The whole deployment is one Worker: `npm run deploy` from the repo root builds all packages and runs `wrangler deploy`; `/api/*` comes from the Worker script and everything else from `packages/frontend/dist` static assets shipped with it.

## Production deployment

See `docs/deployment.md` for the full production deployment guide, `docs/github-app.md` for GitHub OAuth setup, `docs/cloudflare-worker.md` for Worker configuration, and `docs/static-assets.md` for how the frontend assets are served.