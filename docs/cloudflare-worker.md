# Cloudflare Worker Configuration

The backend is a Cloudflare Worker (`packages/backend`). It is the **only** component that holds GitHub credentials, and it also serves the frontend's static assets (see [Serving the frontend](#serving-the-frontend)).

## Configuration File: `packages/backend/wrangler.toml`

### Bindings

All bindings declared in `packages/backend/src/env.ts`:

| Binding | Type | Purpose |
| --- | --- | --- |
| `SESSION_KV` | KV namespace | Stores session tokens, client accesses, encrypted platform connections, and the operator pin. |
| `ASSETS` | static assets fetcher | Serves the built frontend from `packages/frontend/dist`. |
| `GITHUB_CLIENT_ID` | public var | GitHub OAuth client ID (public by design). |
| `GITHUB_REDIRECT_URI` | public var | OAuth redirect URI that routes back to the frontend. |
| `GITHUB_CLIENT_SECRET` | secret (`wrangler secret put`) | GitHub OAuth client secret. **Never exposed to the frontend.** |
| `SESSION_ENCRYPTION_KEY` | secret (`wrangler secret put`) | AES-256 key (base64 or hex of 32 bytes) encrypting GitHub tokens and platform credentials at rest in KV. |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | public var | Cloudflare OAuth client id for "Log in with Cloudflare". Optional — empty disables the button. |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | secret (`wrangler secret put`) | Cloudflare OAuth client secret. Optional (only if the Cloudflare login is enabled). |
| `CLOUDFLARE_OAUTH_REDIRECT_URI` | public var | Registered Cloudflare OAuth callback URL. |
| `VERCEL_OAUTH_CLIENT_ID` | public var | Vercel OAuth client id for "Log in with Vercel". Optional — empty disables the button. |
| `VERCEL_OAUTH_CLIENT_SECRET` | secret (`wrangler secret put`) | Vercel OAuth client secret (Vercel also mandates PKCE). Optional (only if the Vercel login is enabled). |
| `VERCEL_OAUTH_REDIRECT_URI` | public var | Registered Vercel OAuth callback URL. |
| `ALLOWED_ORIGINS` | public var | Comma-separated frontend origins allowed for credentialed CORS. Optional — only for split-domain deployments. |
| `OPERATOR_LOGIN` | public var | GitHub login pinned as the instance operator. Optional — empty means the first GitHub login claims the slot (write-once in KV). |

### Setup steps

1. **Create the KV namespace:**

   ```bash
   cd packages/backend
   npx wrangler kv namespace create SESSIONS_NOMAD
   ```

   Copy the returned `id` into `wrangler.toml`:

   ```toml
   [[kv_namespaces]]
   binding = "SESSION_KV"
   id = "<id>"
   ```

2. **Set public vars** in `[vars]`:

   ```toml
   [vars]
   GITHUB_CLIENT_ID = "<your-client-id>"
   GITHUB_REDIRECT_URI = "https://cms.example.com/auth/callback"
   ```

   The optional platform OAuth vars (`CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_REDIRECT_URI`, `VERCEL_OAUTH_CLIENT_ID` / `VERCEL_OAUTH_REDIRECT_URI`), `ALLOWED_ORIGINS`, and `OPERATOR_LOGIN` also live in `[vars]` — see the comments in `packages/backend/wrangler.toml`.

3. **Set secrets** (never in `wrangler.toml`) — **both** are required:

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_ENCRYPTION_KEY
   ```

   If you enable the platform OAuth logins, also set the two optional secrets:

   ```bash
   npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
   npx wrangler secret put VERCEL_OAUTH_CLIENT_SECRET
   ```

4. **Deploy:**

   ```bash
   npm run deploy
   ```

## Custom Domain

To serve the Worker at a custom domain:

1. In the Cloudflare dashboard, go to **Workers & Pages** → your Worker → **Settings** → **Domains & Routes**.
2. Add a route, e.g. `api.cms.example.com/*`.
3. Keep the frontend `VITE_API_BASE_URL` empty (same-origin) unless you deliberately split the API onto its own domain; in that case set it to `https://api.cms.example.com`.

## CORS

CORS is only needed for **split-domain deployments** — when the frontend is served from a different origin than the Worker (e.g. `cms.example.com` → `api.cms.example.com`). By default the same Worker serves both the API and the assets on one origin, so no CORS configuration is required. When splitting domains, credentialed CORS is required because the session cookie is `SameSite=None; Secure`. The Worker reflects the request `Origin` in `Access-Control-Allow-Origin` only when it appears in `ALLOWED_ORIGINS`, sends `Access-Control-Allow-Credentials: true`, and handles `OPTIONS` preflight. When `ALLOWED_ORIGINS` is unset, no `Access-Control-Allow-Origin` is emitted (dev via the Vite same-origin proxy still works; cross-origin prod fails closed until configured).

1. Set `ALLOWED_ORIGINS` (comma-separated) in `wrangler.toml`:

   ```toml
   [vars]
   ALLOWED_ORIGINS = "https://cms.example.com"
   ```

2. Redeploy the Worker.

## Security headers

Every API response already includes:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`

These are applied in `packages/backend/src/core/http.ts`.

## Local development

Copy `packages/backend/.dev.vars.example` → `packages/backend/.dev.vars` and fill in secrets:

```
GITHUB_CLIENT_SECRET=secret-value
SESSION_ENCRYPTION_KEY=<base64 of 32 bytes>
```

Run the Worker locally:

```bash
npm run dev:backend
```

The Worker listens on `http://localhost:8787`; the Vite dev server proxies `/api` to it.

## Serving the frontend

This Worker is the whole deployment: besides `/api/*`, it serves the built SPA from `packages/frontend/dist` via Workers Static Assets (configured in the `[assets]` block of `wrangler.toml`, with `not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]`). The `_headers` file shipped from `packages/frontend/public/` is honored for the asset routes. See `docs/static-assets.md` for the full asset configuration.