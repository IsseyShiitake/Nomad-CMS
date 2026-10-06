# Self-hosting Nomad CMS

This is the full guide to running your own Nomad CMS instance on Cloudflare —
the script-driven path, every prompt explained, the manual alternative,
updating, and the security model. The quick version lives in the
[README](../README.md#run-your-own-instance).

---

## What you are deploying

One Cloudflare Worker containing the entire CMS: the API and the whole
web UI in a single file (`nomad-cms.worker.js`). It uses one KV namespace
pair for storage (sessions, client accesses, platform connections). It
talks to GitHub on your behalf with a token it obtains via OAuth when you
sign in; your GitHub credentials never touch the frontend.

The CMS does not host your website. Your site stays wherever it is —
GitHub Pages, Cloudflare Pages, Vercel, anywhere that builds from a Git
repository. Nomad CMS commits content changes to that repository; your
existing build pipeline does the rest.

## Requirements

- A free Cloudflare account (Workers + Workers KV — both on the free plan).
- A GitHub account with repositories whose HTML you want to edit.
- Node.js 20 or newer (`node --version`).
- That's it — the bundle has zero npm dependencies, and everything runs on
  your own accounts.

## Part 1 — the setup script

### 1.1 Download

From the [Releases page](https://github.com/IsseyShiitake/Nomad-CMS/releases),
download the three bundle files into one empty folder:

- `nomad-cms.worker.js` — the entire CMS,
- `wrangler.toml` — configuration template,
- `setup.mjs` — the installer.

### 1.2 Run

```bash
node setup.mjs
```

### 1.3 The prompts, one by one

**Worker name** — lowercase letters, digits, dashes. It becomes your URL:
`https://<name>.<your-subdomain>.workers.dev`. It must not already exist
on *your* Cloudflare account — a same-name Worker gets overwritten. Two
instances on one account need two names.

**Your GitHub username** — written to the config as `OPERATOR_LOGIN`.
Exactly this login may hold the admin role on the instance; every other
GitHub login is rejected with `403 instance_locked` at sign-in. This is
write-once if left empty (first sign-in claims it) — filling it removes
the race.

**Cloudflare login** — skipped if you're already authenticated; otherwise
a browser opens for `wrangler login`.

**KV namespaces** — created automatically, titled
`<worker-name>-SESSIONS` and `<worker-name>-SESSIONS-preview`. Titles are
global per Cloudflare account; embedding the Worker name keeps multiple
instances isolated and makes re-runs reuse what exists (never duplicating).

**Probe deploy** — the Worker is deployed once with placeholder vars so
the script can read back your real URL. If the URL can't be parsed from
wrangler's output, the script asks you to paste it.

**The GitHub OAuth app (the one browser step)** — GitHub offers no API to
create OAuth apps, so the script opens
<https://github.com/settings/applications/new> and shows you the exact
values:

- *Application name*: anything ("Nomad CMS" is fine).
- *Homepage URL*: your Worker URL.
- *Authorization callback URL*: `https://<name>.<your-subdomain>.workers.dev/auth/callback`
  — copy it **exactly**; a mismatch fails at sign-in with
  `redirect_uri_mismatch`.

Back in the terminal:

**Client ID** — paste it; it's public by design and goes into
`wrangler.toml`.

**Client secret** — type it hidden. The script pipes it straight into
`npx wrangler secret put GITHUB_CLIENT_SECRET` over stdin: it is never
echoed, never in a process argument, never written to any file. Your CMS
requests the `repo` scope itself at sign-in; nothing else is needed on the
GitHub app page.

**Final deploy + health check** — the script redeploys with your real
config and checks `/api/health` on the live URL.

### 1.4 Done

Open the printed URL, click **Sign in with GitHub**, approve the app, and
you're in. From there: pick a repository, pick a page, edit. Client
accesses for other people are created in the CMS (Clients). Optional
publishing connections to Cloudflare Pages / Vercel are in Settings →
Hosting platforms.

## Part 2 — the manual path

Same result, no installer — for people who distrust scripts.

1. Download the bundle (above).
2. Create the KV namespaces and note the printed ids:
   ```
   npx wrangler kv namespace create my-site-SESSIONS
   npx wrangler kv namespace create my-site-SESSIONS-preview
   ```
3. Edit `wrangler.toml` — every slot is commented:
   - `name` = your Worker name;
   - paste both ids into `[[kv_namespaces]]` (`id` and `preview_id`);
   - `GITHUB_REDIRECT_URI` = `https://<name>.<your-subdomain>.workers.dev/auth/callback`;
   - `OPERATOR_LOGIN` = your GitHub login;
   - platform OAuth ids stay empty (buttons hidden) unless you register
     your own platform apps later.
4. `npx wrangler deploy` — the Worker is live but can't log anyone in yet.
5. Create the GitHub OAuth app
   (<https://github.com/settings/applications/new>) with the callback from
   step 3; paste its Client ID into `GITHUB_CLIENT_ID`.
6. `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste the secret.
7. `npx wrangler deploy` again. Sign in.

## Updating

- Keep your bundle folder; `wrangler.toml` is **your** file — releases
  never touch it.
- To update: replace `nomad-cms.worker.js` with the new release file, then
  `npx wrangler deploy`.
- Re-running `setup.mjs` is optional and safe (it reuses namespaces and
  rewrites the same config slots).
- All data lives in KV and survives updates. Rolling back = redeploying an
  older `nomad-cms.worker.js`.

## Client accesses (logins for other people)

Inside the CMS, the **Clients** area creates restricted logins: each is
locked to exactly one repository, has its own password, locks itself after
repeated wrong attempts, and can be revoked any time. Clients edit only
what you granted — they never see your GitHub token, and the admin role is
impossible for them.

## Publishing integrations (optional)

Editing requires nothing but GitHub. If your site builds on Cloudflare
Pages or Vercel, Settings → Hosting platforms can connect that platform
(token paste, or your own platform OAuth app for Cloudflare) so each save
can trigger a production deployment and follow its build status. Vercel
direct-upload projects appear as editable virtual repositories.

## Security model

- **Session cookies** are HttpOnly + Secure (`__Host-` prefixed); JavaScript
  never sees tokens.
- **Tokens at rest** (GitHub, platform) are AES-256-GCM encrypted in KV.
  The encryption key is your `SESSION_ENCRYPTION_KEY` Worker secret — if
  you omit it, the Worker self-provisions one into KV on first boot (the
  key then lives in the same KV as the data it encrypts: acceptable for a
  single-tenant instance whose only KV reader is the Worker itself; set
  the secret explicitly if you want the stronger guarantee).
- **The OAuth state** for every login is server-issued, single-use, and
  rate limited per IP (10/hour) so the endpoint can't be abused to burn
  KV quota.
- **Operator pinning** is enforced server-side at token exchange.
- **Security headers** (CSP, nosniff, frame-deny, referrer policy) ship on
  every response, in the monorepo deployment and in the single-file bundle.
- **Authors hold nothing**: the whole system runs on your accounts; there
  is no phone-home, no telemetry, no shared service.

## Troubleshooting

See the [README table](../README.md#troubleshooting) for the short list.
Extra depth:

- **`redirect_uri_mismatch`** — the callback on the GitHub app page must
  match `GITHUB_REDIRECT_URI` byte for byte, including `https://` and no
  trailing slash.
- **`instance_locked` at sign-in** — the operator slot is claimed by a
  different login. If the instance is yours and the claim is stale, set
  `OPERATOR_LOGIN` in `wrangler.toml` to your login and redeploy (the
  env var overrides the stored claim).
- **Deploy refuses: KV ids are placeholders** — a `wrangler.toml` with
  zero-filled ids can't deploy; that's deliberate so an unfilled template
  never ships. Run the setup script (or the manual path) to fill them.
- **Lockouts** — a client access that hits its wrong-attempt limit locks
  for a while and then works again; admins can also revoke and recreate
  accesses from the CMS.
- **Rate limited on sign-in (`429`)** — ten sign-in starts per hour per IP
  are allowed; the limit resets within the hour.
- **Wrangler output oddities** — the setup script pins
  `wrangler@4.124.0` for stable output parsing; if a future wrangler
  changes its output, the script falls back to asking you for the URL.

## FAQ

**Can I edit a site that isn't Git-backed?** Not with this CMS — the
editor commits to GitHub; that's the whole model. (Vercel direct-upload
projects are the exception: they are edited via the Vercel API through an
optional connection.)

**Multiple sites?** One instance edits every repository your GitHub
account can access. One instance per *person* is the design; multiple
instances per account are fine (distinct Worker names).

**What does the free tier allow?** For personal use, the Workers free
plan's daily request allowance and KV free tier are comfortably above what
one operator and a few clients generate. See the README FAQ for the short
version.

**How do I completely remove an instance?**
`npx wrangler delete --name <name>`, then delete the two
`<name>-SESSIONS*` KV namespaces, then remove the GitHub OAuth app at
<https://github.com/settings/applications>.
