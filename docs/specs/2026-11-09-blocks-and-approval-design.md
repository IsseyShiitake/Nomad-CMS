# Blocks & harmony on insert + approval workflow — design

Date: 2026-11-09. Author: session agent (GLM-5.3). Status: design final (builder check resolved); implementation follows in the same session. ravi pre-delegated option selection ("run against others, then decide"); every call below is marked and reversible at review.
Companion audit: full findings in the 2026-11-09 session (chat report); this doc covers the two feature tracks plus the audit fixes they carry.

## Intent and why

The CMS is handed to people who do not code. Two things make that unsafe today:

1. **Insertion has no design awareness.** A new paragraph or picture is a bare tag
   dropped next to a beacon. Whether it fits the site's look is a lottery decided by
   the site's CSS selectors. On real client sites (e.g. Saint-Benedict's `qr-row`)
   an inserted image nests *inside* a row item instead of becoming a sibling,
   breaking the row.
2. **Every save commits straight to the production branch.** A client click becomes
   a live site change instantly. ravi wants a toggle: client changes wait for his
   approval before they reach the site.

Plus four smaller audit defects fixed on the way: broken placeholder images and
"New p" text committable as-is; wholesale file reformatting when pages use
shorthand attributes; client home showing "Public" for private repos; silent
destruction of links inside an edited paragraph.

## Goals

- New content inserted next to existing content adopts that content's styling
  parameters (classes, image sizing) — the site's CSS stays the single source of
  design truth; the CMS never injects its own styles.
- A per-client-access toggle: with review required, the client's saves never touch
  the production branch; ravi approves and the change lands.
- Guards: no save while an inserted image still points at the placeholder or an
  inserted element still carries its "New p" placeholder text.

## Non-goals

- No CMS-side layout engine, injected stylesheet, or per-tag spacing rules defined
  by the CMS. The site defines spacing (its own `h1`/`h2`/`p` rules); inserts adopt
  the block's parameters by mirroring siblings. (ravi's "blocks define parameters,
  new content adopts them" — read as: the site's blocks define; the insert adopts.)
- No rich-text editor, no inline-diff preservation of links (warned, not solved —
  v2 candidate).
- No email/webhook notifications (GitHub already emails the repo owner on new PRs).
- `data-cms-block` explicit block metadata: rejected for v1 (authoring burden on
  ravi for every site); revisit only if sibling adoption proves insufficient.
- No server-side placeholder guard: the save guards live in the editor (the path
  non-coders use); a direct API save can still commit placeholder content.
  Verified during E2E — noted as a v2 defense-in-depth candidate (backend would
  scan content for the placeholder src / text on PUT).

## Constraints

- HTML editing stays DOM-based, never regex on HTML (project rule). The
  serializer fix uses deterministic string variants, not regex.
- Clients never touch GitHub credentials; all git work goes through the Worker
  with the admin's token (unchanged).
- Vercel-direct virtual repositories have no branches — review mode is not
  offered there (clients on `vercel/` repos keep direct saves; guarded and
  documented).
- Wire format changes stay backward compatible with existing KV records
  (`requireApproval` defaults to false when absent).

## Approaches considered

### A. Insert harmony

- **A1 Clone-the-sibling (chosen).** When inserting above/below a beacon, copy the
  class attribute (and for `img`: `width`/`height`/`loading`/`decoding`) from the
  nearest same-tag sibling in the same parent — the repeating unit of the block.
  Never copy `id`, `data-*`, `aria-*`, inline handlers, or `style`.
  *Trades:* zero site preparation, works for beacons and `data-editable` sites,
  inserts literally carry the block's parameters, live preview (real site CSS via
  base-href proxy) shows the adopted look before saving. Fails gracefully: no
  same-tag sibling → plain insert, exactly today's behavior.
- **A2 CMS layout blocks (`data-cms-block` metadata + injected CSS).** Rejected as
  v1: every site needs markup work first, injected CSS fights site styles, a new
  authoring concept for ravi to maintain per site.
- **A3 Per-site config file in the repo.** Rejected: config drift, more for ravi
  to write, invisible to non-coders.

*My call: A1.* It answers "new content adopts the parameters defined in the
block" with no per-site work, and the preview already renders the truth.

### B. Approval workflow

- **B1 Review branch + pull request (chosen).** With review required for a client
  access, that client's page saves and image uploads target a per-client branch
  `cms/<clientId>` (created from the default branch on first save); the Worker
  ensures one open PR `cms/<clientId> → main` exists and updates it per save.
  Production (deploys build from `main`) never moves until ravi merges the PR on
  GitHub (or via the CMS's merge button). After merge the next save starts a new
  PR on the same branch.
  *Trades:* reuses git's own review model — nothing can bypass a merge, history is
  the audit trail, GitHub's diff view is free, GitHub notifies ravi of new PRs
  natively. Client reads (page content, pages list, raw preview assets) switch to
  the review branch so the client sees their own pending work. Cost: ref-aware
  read paths for approval-mode clients.
- **B2 KV proposal queue.** Client PUTs stored in KV; CMS UI to list/preview/
  approve/reject; approve commits to main. Rejected: builds a parallel review
  system git already has; proposals drift when `main` moves underneath; much more
  UI and KV surface for the same guarantee.
- **B3 B1 + extra notification plumbing.** Rejected: GitHub already emails on PR
  creation/updates.

*My call: B1.* "Sends it my way" = an open PR on ravi's own repo; the production
branch is untouched until his merge. Note the honest distinction: the client's
commits do exist — on a side branch, never on `main`, and no production deploy
runs from them.

## What gets built (the how-decisions)

### Phase 1 — editor honesty (all sites, all roles)

1. **Sibling adoption on insert** (`parser.ts insertSibling`): clone `class` from
   the nearest same-tag sibling within the same parent; for `img` also
   `width`/`height`/`loading`/`decoding`; `alt` stays empty (content, not
   template). In editable mode the created element still gets `data-editable`.
2. **Save guards** (`editorState.save`): refuse to save while any inserted image
   still has the placeholder `src`, or any element's text is still the unedited
   `New <tag>` placeholder. Error names the offending elements (localized).
3. **Serializer tolerance** (`parser.ts apply`): when the serialized `outerHTML`
   is not found verbatim in the source, retry with empty-value attribute variants
   (`attr=""` ↔ `attr` ↔ `attr=''`, capped at 8 combinations) before falling back
   to full re-serialization. Full fallback also preserves a lost trailing newline.
4. **Delete hygiene**: removing an element that sat alone on its line swallows the
   line's indentation (no whitespace-only lines in diffs).
5. **Inline-markup warning**: panel rows for elements containing inline markup
   (`a`, `strong`, `em`, …) show a "contains formatting" badge; saving an edit to
   such an element gets an explicit confirm listing what will be flattened.
6. **Client-home badge**: stop fabricating `isPrivate: false`; the client tile
   shows no visibility badge (the client's repos are the operator's choice).

### Phase 2 — approval workflow (B1)

Backend:
- `ClientRecord.requireApproval?: boolean` (KV, default false). Admin toggle:
  `POST /api/clients/:id/approval {"requireApproval": bool}`. Client sessions
  carry `clientId`; the save path reads the live flag at save time (toggles apply
  immediately, not at next login).
- Save/upload routing: client + requireApproval → resolve/create `cms/<clientId>`
  branch from the default branch HEAD; `writeFile`/`uploadImage` with that ref;
  ensure open PR (search `head=<owner>:cms/<clientId>`, create if none, title
  `CMS changes from <label>`). Response gains `pendingApproval: true` + `prUrl`.
- Client read routing when the branch exists: page read and the raw proxy
  resolve from the branch, falling back to the default branch for paths absent
  there (a page added on production while a change is pending stays readable).
  Known limit: the pages/contents LISTS come from the branch alone — a
  production-only page does not appear in the list until the pending change is
  merged or rejected (merging two git trees per list request is not worth it
  at this load). Image listing is branch-first.
- Admin review routes (admin-only): `GET /api/review` lists open `cms/*` PRs for
  the repositories of approval-mode client accesses (bounded iteration over
  accesses, not a whole-account scan); `POST /api/review/:owner/:repo/:number/merge`
  first asks GitHub to update the PR branch from the base branch (clears routine
  staleness), then merges; on a successful merge it runs the existing publish
  flow (same one the admin editor's auto-publish uses) so platform-connected
  sites update immediately; git-integrated platforms deploy from `main` on their
  own. Conflict after update-branch → structured error with the PR link
  ("resolve on GitHub"). `POST /api/review/:owner/:repo/:number/close` =
  reject: closes the PR and deletes the branch (next save re-anchors fresh).
- Branch lifecycle: when a client save finds no open PR for its branch, the
  branch is deleted and recreated from the current default HEAD first — rejected
  commits never resurface, and most staleness conflicts never form. Multiple
  approval clients on one repo are allowed but one pending client per repo is
  the documented recommendation.
- Push rights: not pre-validated; a repo the admin's token cannot push to fails
  at first save with the normal mapped GitHub error. Documented: review mode
  needs push access to the repository.
- Flag not offered for `vercel/` virtual repos (no branches) — creation route
  rejects, UI hides the toggle.

Frontend:
- Settings → client access rows get a "Require approval" toggle (admin).
- Settings → "Pending reviews" panel: open PRs with page list, age, link to
  GitHub diff, Merge button.
- Client editor: save success shows "Submitted for approval" (+PR link) instead
  of "Page saved"; a banner on load states review mode is on for this site.
- i18n: all of the above in EN + FR.

### Phase 3 — docs & tests

- Tests: parser (sibling adoption, variant matching, delete hygiene), editorState
  (guards), backend (approval routing, branch/PR lifecycle, toggle auth, vercel
  rejection), frontend (badge, banners). Full suites must pass: backend 181+new,
  frontend 107+new.
- Docs: README features + security model paragraph, self-hosting (client
  accesses: review mode), architecture (branch flow).

## Left to the builder

Nothing open; all decisions above are made (builder-check questions 2026-11-09
resolved into this doc: status honesty, publish-after-merge, reject/reset
lifecycle, topology scoping, verification standard). End-to-end verification for
*this* session runs against its deployed audit rig; a future builder re-verifies
with the unit suites plus their own dry-run instance.
