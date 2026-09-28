# Static Assets (Workers Static Assets)

The frontend is not a separate deployment. The single Worker (`nomad-cms`) serves `/api/*` from the Worker script and everything else from the built SPA in `packages/frontend/dist`, using Cloudflare's [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/). This document covers how that asset serving is configured.

## The `[assets]` block in `packages/backend/wrangler.toml`

```toml
[assets]
directory = "../frontend/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]
```

| Key | Meaning |
| --- | --- |
| `directory` | The local directory uploaded as static assets — the Vite build output of the frontend. |
| `binding = "ASSETS"` | Exposes the assets to the Worker script as an `ASSETS` fetcher, so the script can serve asset responses itself if it ever needs to. |
| `not_found_handling = "single-page-application"` | Any request that does not match an asset file and is not handled by the Worker falls back to `index.html`, so React Router handles client-side navigation on deep links (e.g. `/repositories/owner/repo/editor/path`). This replaces the old `_redirects` file, which has been deleted. |
| `run_worker_first = ["/api/*"]` | Requests under `/api/*` always invoke the Worker script first instead of being matched against assets; everything else goes to the asset layer unless the Worker handles it. |

## SPA fallback

There is no `_redirects` file anymore. With `not_found_handling = "single-page-application"`, unmatched routes natively serve `index.html` with a 200 status — same behavior the `_redirects` rule (`/* /index.html 200`) used to provide on Pages.

## `_headers` support

The file `packages/frontend/public/_headers` is copied into the build output by Vite and **is honored by Workers Static Assets**. It applies security headers on every route:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' https: data:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

The `index.html` route is cached with `Cache-Control: public, max-age=0, must-revalidate` so updates propagate quickly.

### Where the CSP comes from

`packages/frontend/index.html` is the single source of truth for the policy (its CSP meta tag carries the value above; fonts load from `fonts.googleapis.com` / `fonts.gstatic.com`, and `img-src` allows any `https:` image plus inline `data:` URIs). The `_headers` CSP is **regenerated at build time** from the built `index.html`'s meta tag by the `cspPlugin` in `packages/frontend/vite.config.ts`, so the two can never drift.

### The `CMS_API_ORIGIN` placeholder

The CSP in the `packages/frontend/public/_headers` source file contains a literal `CMS_API_ORIGIN` token in `connect-src`. At build time, the `cspPlugin` in `packages/frontend/vite.config.ts` regenerates the whole CSP line in the output `_headers` from the built `index.html`'s meta tag:

- If `VITE_API_BASE_URL` is set (split-domain deployments), that origin is appended to `connect-src` in the built `index.html`, so the regenerated `_headers` policy allows calls to the API.
- If it is unset (the default same-origin deployment), `connect-src` stays `'self'`.

See `packages/frontend/vite.config.ts` (`cspPlugin`) for details.

## Custom domain

To serve the Worker at a custom domain:

1. In the Cloudflare dashboard, go to **Workers & Pages** → your Worker → **Settings** → **Domains & Routes**.
2. Add the domain (e.g. `cms.example.com`) and follow the DNS instructions.

Changing the domain requires updating two places, then redeploying:

- `GITHUB_REDIRECT_URI` in `packages/backend/wrangler.toml` `[vars]` (e.g. `https://cms.example.com/auth/callback`)
- The GitHub OAuth App's callback URL list (add `https://cms.example.com/auth/callback`)

Then run `npm run deploy` from the repo root.
