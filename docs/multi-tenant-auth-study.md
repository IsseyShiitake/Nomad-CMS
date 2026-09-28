# Multi-tenant access study — can anyone log in without their own OAuth credentials?

Date: 2026-09-16 · Requested by: ravi · Status: **analysis only — nothing implemented**

## The question

> Study the doability of allowing anyone to connect to their GitHub / Cloudflare /
> Vercel account without needing a client secret and a client ID. The goal: anyone
> with a website on any of the three platforms can log in securely and edit their
> site's content, with no local files. If not realistically doable, simplify so
> anyone other than me needs at most two local files (client id + secret) to
> connect to their own repos.

The phrase "without a client ID/secret" means different things for **end users**
vs **instance operators** — the answer differs sharply between the two, so both
are analyzed.

## Ground truth from the current code (verified 2026-09-16)

- `routes/auth.ts` POST `/api/auth/exchange` has **no admin allow-list**: any
  GitHub user who completes the OAuth dance gets `kind: 'admin'`. Every GitHub
  API call afterwards uses *that user's own* token, so repo access is scoped by
  GitHub itself — but every sign-in also gets CMS-side admin powers: creating
  client accesses, connecting hosting platforms, listing **all** client records
  (the `client:` KV namespace is global, not per-admin).
- Session GitHub tokens and deploy-connection tokens are AES-256-GCM encrypted
  in KV (`SESSION_ENCRYPTION_KEY`); the cookie is `__Host-` prefixed, HttpOnly.
- Deploy connections are already keyed per GitHub login
  (`deploy:{owner}:{platform}`) — structurally ready for multi-user.
- The GitHub OAuth App (client id `Ov23li…`) requests scope `repo` — full
  control of *all* repositories of the authorizing user.

## Scenario A — one shared deployment (everyone logs into the same instance)

### GitHub: technically works today; needs hardening before it is "secure"

End users never need a client ID/secret — those belong to the operator's
Worker. Any GitHub user can already click *Sign in with GitHub* and land as an
admin of their own repos. What stands between "works" and "responsibly secure":

1. **Admin parity is wrong for strangers.** Every sign-in manages the global
   client list and can connect platforms. Fix: treat the first-ever login (or an
   env-pinned login) as operator; everyone else becomes a `member` kind with
   self-service rights only (own repos, own connections), plus per-owner
   namespacing of client accesses.
2. **Token custody = trust in the operator.** Strangers' GitHub tokens live in
   *my* KV. At rest they are encrypted, but the operator (me) can decrypt. This
   is inherent to every hosted CMS (Netlify CMS gateways, Forestry, etc.) and is
   exactly what GitHub's OAuth consent screen warns about. Not a code bug — a
   trust model that must be disclosed.
3. **Scope is too broad for strangers.** `repo` grants all repos, public and
   private. GitHub users will (rightly) balk. The fix is migrating to a
   **GitHub App**: users install it per-repository, tokens are installation-
   scoped, and consent reads "this app can access repo X" instead of
   "everything". GitHub Apps also mint short-lived (1 h) installation tokens —
   strictly better than a long-lived OAuth token sitting in KV. Cost: real
   backend work (installation-token minting replaces the saved user token;
   save/commit flows re-authenticated per session or per hour).
4. **Unverified-app friction + abuse.** An OAuth App/GitHub App not owned by a
   verified organization shows security-review warnings to users outside the
   owner. A publicly-open instance also needs rate limiting, a ToS/privacy
   page, and someone answering abuse mail. These are operational costs, not
   code.

### Cloudflare: not available to other accounts — by design

Cloudflare OAuth clients are account-scoped and **private by default**: only
members of the creating account can authorize. Letting *other people's* CF
accounts connect requires promoting the client to **public**, which is
irreversible and requires a TXT-verified client domain (a real domain the
operator controls — not `*.workers.dev`). The project log already carries a
standing "do NOT promote" note (Q2). Verdict: possible on paper, a one-way door
plus a domain purchase, for a feature (publish-to-CF) whose value to strangers
is speculative. **Not recommended.**

### Vercel: identity works, function does not

"Sign in with Vercel" is GA for identity (OIDC), but **API permissions for
OAuth access tokens are still in private beta** (verified Sept 2026 — multiple
open community threads asking for access). The `vca_` token cannot list
projects or trigger deployments. A stranger "logging in with Vercel" would
store a connection that can do nothing; the functional path remains pasting a
personal API token — which a stranger should *not* paste into someone else's
CMS. Verdict: **not doable today**, regardless of security.

### Scenario A verdict

**Partially doable**: "anyone with a GitHub-hosted site can log in and edit,
zero files, zero credentials of their own" is achievable — but only after the
hardening in items 1–4, and it makes *me* the custodian of strangers' GitHub
access. Cloudflare and Vercel logins for strangers are effectively off the
table (one-way door / private beta). "Without compromising security" holds only
in the sense that every hosted SaaS claims it: the operator remains a trusted
party.

## Scenario B — each user runs their own instance (recommended direction)

The architecture is already a single self-contained Worker; the natural
multi-user story is **"Deploy to Cloudflare" self-hosting**, where each website
owner runs their own Nomad CMS on their own free Cloudflare account. Then:

- **GitHub**: the instance needs its own OAuth app. Two sub-options:
  1. *Manual (today):* create an OAuth App, put the client id in
     `wrangler.toml`, `wrangler secret put` the secret. One file edit + one
     interactive command — **zero secret files on disk** (`.dev.vars` is only
     for local dev).
  2. *Zero-touch (buildable):* the **GitHub App manifest flow**
     (`github.com/settings/apps/new` + one-time code exchange) lets the user
     register a GitHub App by clicking one button *on their fresh instance*;
     GitHub returns the client id/secret to the Worker, which stores them
     encrypted in KV (config-in-KV pattern). No files at all. Bonus: the app is
     a GitHub App, which gets the per-repo consent and short-lived tokens from
     day one. This is the single most valuable investment if sharing the CMS
     beyond ravi is the goal.
- **Cloudflare**: the self-hoster owns the CF account that runs the Worker, and
  a *private, account-scoped* OAuth client is exactly right for that — the
  limitation that blocks Scenario A is a perfect fit here. Creating the client
  is manual (no public API), ~3 minutes in the dashboard; token paste remains
  the fallback. No local files either way.
- **Vercel**: same API-permissions beta wall as Scenario A. Token paste (of
  *their own* token, into *their own* worker — acceptable). Revisit when Vercel
  GAs API permissions.

Security in Scenario B is genuinely clean: every user's tokens live only in
their own Worker/KV, encrypted with their own key. There is no shared party to
trust beyond Cloudflare itself. The cost is the deploy step (a "Deploy to
Cloudflare" button on a public repo reduces this to a few clicks) and the
GitHub app setup (manifest flow removes even that).

## The "two local files" fallback — already better than that

Measured today, a self-hoster needs **at most one file**:

| Artifact | Required? | Purpose |
| --- | --- | --- |
| `packages/backend/.dev.vars` | local dev only | GitHub secret + session key (gitignored) |
| `wrangler.toml` edit | production | client id as a `[vars]` value |
| `wrangler secret put` | production | secret + session key — interactive, **no file** |
| `packages/frontend/.env.local` | **not required** | config defaults to same-origin + app name |

If even the `wrangler.toml` edit should go away, the first-run wizard
(config-in-KV, same mechanism as the manifest flow) covers it. The two-file
worst case only materializes for local development, where files are the
convention anyway.

## Recommendation

1. **Do not open the shared instance to the public.** Keep
   the shared instance single-operator. If it must accept other
   *specific* people (friends/clients), that is what the existing client-access
   system is for.
2. **If sharing is the goal, build Scenario B**: publish the repo, add a
   Deploy-to-Cloudflare button, then implement the GitHub App manifest flow +
   first-run wizard (zero files, per-repo consent, short-lived tokens). This is
   a milestone-sized effort (~backend session-flow rework + wizard UI + docs),
   not a quick patch.
3. **Vercel OAuth stays deferred** until API permissions GA; **Cloudflare
   OAuth stays private** — self-hosters each register their own client.
4. Meanwhile, one cheap hardening for the shared instance (defence in depth,
   ~30 lines): restrict `/api/clients*` management to an env-pinned operator
   login so a stray sign-in cannot touch client accesses. Worth doing
   regardless of direction, since today *any* GitHub user who signs in gets
   that power.

## Sources

- Cloudflare OAuth clients, public promotion & domain verification:
  [Create your OAuth client (Cloudflare docs)](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
  [Self-managed OAuth clients changelog (June 2026)](https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/),
  [Practical notes on integrating a Cloudflare OAuth client](https://www.ubitools.com/cloudflare-oauth-client)
- Vercel API permissions still private beta:
  [How to get access to Sign in with Vercel API Permissions (private beta)?](https://community.vercel.com/t/how-to-get-access-to-sign-in-with-vercel-api-permissions-private-beta/44972),
  [Requesting access to OAuth API Permissions Private Beta](https://community.vercel.com/t/requesting-access-to-oauth-api-permissions-private-beta-building-a-native-ios-client-for-vercel/44248),
  [Scopes and Permissions (Vercel docs)](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions)
- GitHub App manifest flow (self-service registration):
  [Registering a GitHub App from a manifest (GitHub docs)](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
  [Use GitHub App manifests to simplify your onboarding](https://runs-on.com/blog/self-serve-github-app-registration-with-manifests/)
