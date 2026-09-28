# Production Checklist

Use this checklist before and after deploying the CMS to production.

## Before deploy

- [ ] GitHub OAuth App created with the correct callback URL (`https://<your-domain>/auth/callback`).
- [ ] `packages/backend/wrangler.toml` has the real KV namespace id.
- [ ] `GITHUB_CLIENT_ID` and `GITHUB_REDIRECT_URI` set to production values.
- [ ] `OPERATOR_LOGIN` set to the operator's GitHub login (empty = first sign-in claims the slot; every other login gets `403 instance_locked`).
- [ ] `GITHUB_CLIENT_SECRET` and `SESSION_ENCRYPTION_KEY` set via `wrangler secret put` (never committed).
- [ ] Split-domain deployments only: `ALLOWED_ORIGINS` set to the frontend origin(s) in `wrangler.toml` `[vars]` (enables credentialed CORS). Not needed for the default single-Worker same-origin deployment.
- [ ] Frontend `VITE_*` variables set in `packages/frontend/.env.production` before deploying (public values only).
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes (frontend + backend).

## After deploy

- [ ] Visit the production URL and confirm the app loads.
- [ ] Sign in with GitHub and complete the OAuth flow.
- [ ] Select a repository, open a page, make an edit, and save.
- [ ] Upload an image and confirm it commits.
- [ ] Verify the Worker returns security headers (`curl -I https://<worker-url>/api/health`).
- [ ] Verify the Worker-served frontend assets return security headers (`curl -I https://<worker-url>/`).
- [ ] Confirm SPA routing works on a deep link (e.g. `/repositories`).

## Security review

- [ ] No secrets in the repository (check `.env`, `.dev.vars`, `wrangler.toml`).
- [ ] GitHub credentials only exist in the Worker secrets.
- [ ] The session token is carried in an HttpOnly cookie (never exposed to JS); no token in localStorage.
- [ ] State-changing API calls carry an `X-CSRF-Token` header (CSRF defense).
- [ ] GitHub tokens are encrypted at rest in KV with `SESSION_ENCRYPTION_KEY`.
- [ ] API responses include `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`.
- [ ] The frontend HTML includes a CSP meta tag.
- [ ] The `_headers` file is present in the build output.

## Performance

- [ ] Feature pages are lazy-loaded (verify separate chunks in `dist/assets/`).
- [ ] The initial bundle is reasonable (check the build output sizes).
- [ ] `index.html` is served with `must-revalidate` so updates propagate.