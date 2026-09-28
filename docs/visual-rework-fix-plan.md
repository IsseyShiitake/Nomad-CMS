# Visual Rework — Fix Plan (executor brief)

Status: researched + root-caused by lead. Every claim below was verified against
source and, where possible, reproduced in a live browser (headless Chromium via
the omp browser tool; a `vite` dev server instance is already running on
**http://localhost:5174** as hub process `vite` — the user's own server may hold
5173; check `hub ps` / logs before starting another).

Work in this order: **A (toggle) → B (intro motion) → C (intro type/centering) →
D (repo thumbnails)**. A–C are CSS/TSX-local; D is the only structural change.
Run the verification protocol at the end of each step, not just at the end.

House rules that constrain every change:
- All durations are `calc(Nms * var(--speed))` (`--speed: 0.7`, theme.css). JS
  timers in IntroOverlay.tsx are pre-scaled constants that mirror the CSS — if
  you change a CSS duration, change the matching TS constant.
- Every animated construct has a `prefers-reduced-motion` fallback in the same
  file. Keep them working.
- No new webfonts, no new dependencies, no backend changes (the existing
  backend endpoints are sufficient — see D).
- House style: display type is italic serif (`--font-display`), comments are
  prose explaining *why*. Match it.

---

## A. Theme toggle glitch (light/dark button)

**Symptom (user screenshot `~/Pictures/Screenshots/button.png`, verified by
pixel analysis + live repro at deviceScaleFactor 1.5):** grey crescents on the
left rim and a grey nub on the right rim of the disc; the half-white/half-black
disc appears mis-seated inside a grey ring.

**Root cause:** `.theme-toggle` (packages/frontend/src/styles/global.css:332-348)
draws the disc with `background: conic-gradient(#111 0 50%, #fff 0)` plus a
**1px translucent `border: 1px solid rgba(0,0,0,0.55)`**. At fractional device
pixel ratios (1.25/1.5/1.75) the border ring and the background disc rasterize
to different device-pixel coverage, so the translucent border shows *inside*
the disc as grey fringes (worst where the white half meets it). Reproduced at
DPR 1.5 in headless Chromium; removing the border removes the artifact.

Secondary defect found while researching: the global
`button:focus-visible { box-shadow: var(--focus-ring) }` (global.css:123-130)
overrides the toggle's own `box-shadow`, so keyboard focus drops the disc's
edge definition entirely. The fix below re-asserts it.

**Change (global.css:332-348 only):** drop the border; carry the rim as an
inset ring inside `box-shadow` (inset shadows rasterize with the background,
no fractional-DPR mismatch — prototype verified clean at DPR 1.5):

```css
.theme-toggle {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: conic-gradient(#111 0 50%, #fff 0);
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28), var(--shadow-sm);
  transition: box-shadow calc(0.15s * var(--speed)) var(--ease-soft),
    transform calc(0.15s * var(--speed));
}

.theme-toggle:hover {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28), var(--shadow-md);
  transform: translateY(-1px);
}

.theme-toggle:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28), var(--focus-ring);
}
```

**Acceptance:** browser at `deviceScaleFactor: 1.5` (raw puppeteer:
`tab.page.setViewport({width:1280,height:800,deviceScaleFactor:1.5})`), on
`/login` (FloatingControls) and on any authenticated header: selector
screenshot of `.theme-toggle` shows a clean half/half disc in light AND dark
theme, no grey crescent/nub at rest, on hover, and with `:focus-visible`
(keyboard-tab to it). Also confirm at DPR 1 and 2.

---

## B. Welcome / Bienvenue trajectory

**User spec:** words appear from the side borders at 100% speed, decelerate
*exponentially* on approach to the center, stay ~5% speed / legible near the
center for **~1s**, then the animation *reverses*: speed increases
exponentially as they leave the center out the opposite side.

**Current state (packages/frontend/src/features/intro/IntroOverlay.css):**
`.intro__word--welcome` / `--bienvenue` (lines 80-86) run
`calc(4400ms * var(--speed))` (= 3080ms) of `intro-welcome-drift` /
`intro-bienvenue-drift` (lines 93-157). The existing per-stop beziers give a
fast-in / slow-center / fast-out feel but the center drift is too long and too
fast relative to the spec and the entry/exit easing is not exponential.

**Change:** rebuild both keyframe blocks with a 3-phase exponential profile.
Recommended shape (tune by eye, acceptance is the feel):

```css
.intro__word--welcome,
.intro__word--bienvenue {
  animation-duration: calc(4700ms * var(--speed)); /* ≈3.29s scaled */
}

@keyframes intro-welcome-drift {
  0% {
    opacity: 0;
    transform: translateX(-55vw);
    animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); /* expo-out: full speed → exponential decay */
  }
  7% { opacity: 0.78; }
  35% {
    transform: translateX(-2.25vw);
    animation-timing-function: linear; /* ≈1s legible drift across center at ~5% entry speed */
  }
  65% {
    transform: translateX(2.25vw);
    animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); /* expo-in: exponential acceleration out */
  }
  92% { opacity: 0.78; }
  100% { opacity: 0; transform: translateX(58vw); }
}
/* intro-bienvenue-drift: identical with every X sign flipped (55, 2.25, -2.25, -58). */
```

Math to preserve: middle segment ≈ 30% of total; scaled total = 0.7 × T with
0.3 × 0.7 × T ≈ 1000ms → T ≈ 4700ms. Entry/exit each ≈ 1.15s scaled, covering
±55vw (that is the "100% speed" entry). If you retune percentages, keep:
(1) center dwell ≈ 1s scaled, (2) entry/exit visibly exponential (no linear
cruise, no hard velocity jump at the joins — the expo-out tail speed should be
close to the middle drift speed), (3) opacity fades unchanged.

**TS sync (IntroOverlay.tsx:13):** `WELCOME_SCENE_MS = 3220` mirrors the scaled
journey + buffer. New scaled journey = 0.7 × 4700 ≈ 3290ms → set
`WELCOME_SCENE_MS = 3450` (journey + ~160ms buffer) and update the comment.
The `NOMAD_*` constants are relative to it; leave them.

**Reduced motion** block (IntroOverlay.css:335-372) stays as is.

**Acceptance:** fresh tab session (clear `sessionStorage['cms.intro-seen']` or
open a new incognito context — the intro only replays once per tab session),
screenshot/observe at ~0.2s (word near border, fast), ~1.2-2.2s (word near
center, legible, barely moving), ~3s (gone/exiting fast). Both words mirror
each other (Welcome L→R, Bienvenue R→L). No visible velocity discontinuity at
the phase joins.

---

## C. "CMS" letterform + stacked centering under "Nomad"

Two changes, same two files (IntroOverlay.css / IntroOverlay.tsx).

### C1 — thinner capitals
`.intro__acronym` (IntroOverlay.css:221-231) currently inherits
`--font-display` (Didot, 'Bodoni MT', 'Playfair Display', Georgia, serif) at
weight 400. On Linux this resolves to **Georgia-class metrics = chunky** (this
is what the user sees). Give the acronym its own lighter stack and weight:

```css
.intro__acronym {
  font-family: Didot, 'Bodoni MT', 'Playfair Display', 'Times New Roman',
    'Liberation Serif', Georgia, serif;
  font-weight: 300;
  /* …rest of existing rule unchanged (size/gap/tracking/uppercase/color) */
}
```

Rationale: mac/win still hit Didot/Bodoni MT first (already thin, high
contrast); Linux falls through to Times New Roman → fontconfig alias
(Liberation Serif), a visibly thinner capital than Georgia; `font-weight: 300`
thins it further where a light face exists and is a harmless no-op otherwise.
**Do not touch `--font-display`** (Nomad and all other display text must keep
its current look).

Coupled rule: `.intro__acronym-tail` (IntroOverlay.css:261-283) hard-sets
`font-family: var(--font-display)` — the unfolded tails ("ontent", "anagement",
"ystem") would no longer match their capitals. Change it to inherit the
acronym stack (delete the `font-family` line; it inherits from
`.intro__acronym-word` → `.intro__acronym`).

**Acceptance:** CMS capitals render visibly thinner than before (compare
before/after screenshots), tails match their capital's letterform.

### C2 — stacked column centered under "Nomad"
**Current behavior:** `measureStackOffsets` (IntroOverlay.tsx:90-103) glides M
and S under C with `--sx = anchorRect.left - rect.left` (anchor = C). The
capital column therefore keeps C's original left position — left of center —
and after the tails unfold the whole "Content / Management / System" block
sits off-center relative to "Nomad". This is the user's complaint.

**New behavior:** when the tails finish unfolding, the stacked block's
bounding box is horizontally centered under "Nomad". (Each row stays
left-aligned inside the block — it is a column, not centered-per-row.)

Implementation in `measureStackOffsets` (runs once, right before
`.intro--stacked`, while tails are still `max-width: 0` but laid out):

1. Add a ref to the "Nomad" span (`.intro__name`, IntroOverlay.tsx:157) — e.g.
   `nameRef` — instead of querying the DOM.
2. For each acronym word, compute its *unfolded* row width:
   `rowWidth = word.getBoundingClientRect().width + tail.scrollWidth`
   (`word` = the `.intro__acronym-word` span — its in-flow width is just the
   capital since the tail is absolutely positioned; `tail.scrollWidth` is the
   clipped nowrap content width, measurable even at `max-width: 0`).
   Subtract the tail's `-0.04em` overlap if you want pixel perfection; not
   required.
3. `blockWidth = max(rowWidths)`; `center = nameRect.left + nameRect.width / 2`;
   `targetLeft = center - blockWidth / 2`.
4. Per word k: `--sx = targetLeft - wordRect.left` (C now moves too — delete
   the "C stays" special case and update the stale comments in
   IntroOverlay.tsx:85-89 and IntroOverlay.css:250-259 accordingly),
   `--sy = k * line` unchanged.

Nothing else changes: transforms stay translate-only on the word wrappers,
"Nomad" never moves, the unfold timing is untouched.

**Acceptance:** after the unfold completes (~WELCOME_SCENE_MS + 2380ms +
800ms), measure in the page:
`|centerOf(stacked block bbox) − centerOf(.intro__name)| ≤ 2px`, where the
stacked block bbox = union of the three `.intro__acronym-word` rects *including
tails* (measure after `.intro--words` is set; tails are visible then).
Screenshot must read as "CMS column centered under Nomad".

---

## D. Repository miniatures: render from repo content + fix hover corners

**Symptoms:** (1) only `saintbenedictcenterwest` shows a miniature — every
other tile shows the pastel monogram; (2) on hover the website capture's
square corners stick out of the tile's rounded corners.

**Root causes (verified):**
1. `RepoTile` (packages/frontend/src/ui/components/RepoTile.tsx) only renders
   a miniature from a *live published URL* (owner homepage or the
   `*.github.io` Pages convention) via `/api/preview`. Repos without a
   published Pages site 404 the preflight and fall through to the monogram —
   even though their HTML exists in GitHub and the CMS can already render it:
   the editor preview does exactly this (`buildSrcDoc` in
   features/editor/EditorView.tsx:55-104 + same-origin raw proxy
   `/api/repositories/:owner/:repo/raw/...`, backend routes/repositories.ts:184-206,
   `safeAssetPath` has **no** extension restriction so CSS/images/fonts load
   with correct MIME).
2. The hover lift (`transform: translateY(-3px)` on `.repo-thumb`,
   RepoTile.css:180-184) promotes the tile to its own compositor layer; with a
   cross-process iframe inside, Chromium's compositor can ignore the
   ancestor `overflow: hidden` + `border-radius` clip (user's GPU setup does;
   headless SW-composited Chromium does not — do not "verify it's fine", the
   user report is ground truth). `clip-path` clips in the paint phase and is
   immune to this.

**Changes:**

### D1 — clip the corners (RepoTile.css)
Add to `.repo-thumb` (RepoTile.css:7-18), keeping `overflow: hidden`:

```css
clip-path: inset(0 round var(--radius-lg, 18px));
```

**Acceptance:** on the live repositories page, hover every tile; screenshot
the corners mid-hover and after — no square capture corners outside the
rounded border, in light and dark theme.

### D2 — repo-rendered miniature as new fallback tier (RepoTile.tsx)

Extract the sanitizer so both editor and tile share it:
- Move `buildSrcDoc(html, baseHref, elementSelector)` from
  EditorView.tsx:55-104 to `packages/frontend/src/services/htmlParser/`
  (or a new `src/services/preview/index.ts` — pick one, update imports).
  EditorView keeps calling it with its selector; RepoTile calls it with
  `elementSelector = null`. `resolveClickedElementId` stays in EditorView
  (its test imports it from there).

New candidate chain in RepoTile (replace the URL-only chain; keep the
existing states/observers/timeout logic, keep `thumbnailCandidates` +
`previewSrc` as tier 1 exactly as today):

1. **Tier 1 (unchanged):** homepage / Pages-convention URLs via `/api/preview`
   preflight + iframe `src`.
2. **Tier 2 (new):** when tier-1 candidates are exhausted (today:
   `setFailed(true)`), instead fetch the repo's own HTML and render it:
   - `listPages(repo.owner, repo.name)` (api/repositories.ts) → pick
     deterministically: `index.html` at root, else any `*.html` at root, else
     first page in the list;
   - `getPage(owner, repo, path)` → `buildSrcDoc(page.content, baseHref, null)`
     with `baseHref` built exactly like EditorView.tsx:181-184
     (`${origin}/api/repositories/${owner}/${repo}/raw/${dir}/`, dir = the
     page's directory);
   - render in the same scaled iframe via `srcDoc` (same
     `sandbox="allow-same-origin"`, same `--thumb-scale` /
     `--thumb-viewport-height` cover-fit, same `onLoad` → loaded fade-in).
     CSP already permits this pattern (the editor runs srcDoc iframes in
     production).
   - Works for private repos too (raw proxy authenticates via the session).
3. **Tier 3 (unchanged):** monogram fallback when tier 2 errors or the repo
   has no HTML at all.

Keep the 9s `FALLBACK_TIMEOUT_MS` per attempt; tier-2 fetch failures go
straight to tier 3 (no retry loop). Update the component doc comment to
describe the three tiers. No new user-facing strings. No backend changes.

Consumers to keep working (they build Repository-shaped objects with only
owner/name — tier 2 must read `repo.owner`/`repo.name`, nothing else):
features/pages/PagesPage.tsx:52 (banner), features/client/ClientPagesPage.tsx:62
(hero + banner).

**Acceptance:** on the live `/repositories` page (real session): every repo
that contains at least one HTML file shows a website miniature (repo
rendered) instead of the monogram; `saintbenedictcenterwest` still shows its
live capture; repos with zero HTML files still show the monogram. Client
login pages (`/client/...`) and `/repositories/:owner/:repo/pages` banners
show miniatures too.

---

## Verification protocol (run after each step, and at the end)

1. `npm run typecheck` and `npm test` at repo root — must stay green
   (RepoTile.test.ts only covers `thumbnailCandidates`; EditorView.test.tsx
   covers `resolveClickedElementId`; neither may break).
2. Backend: `npm run dev:backend` (wrangler, port 8787; `.dev.vars` present)
   if not already running; frontend: reuse hub process `vite` on
   http://localhost:5174 or `npm run dev:frontend`.
3. Browser checks (omp browser tool; `tab.page.setViewport` for DPR;
   `tab.page.hover` for hover):
   - A: toggle close-ups per its acceptance.
   - B/C: clear `sessionStorage` (`cms.intro-seen`) then reload `/`; observe
     the welcome drift per B acceptance; then the Nomad scene per C
     acceptance (measure centering numerically with `tab.evaluate`, do not
     eyeball only).
   - D: authenticated `/repositories` per D acceptances; hover corners;
     light + dark theme.
4. `prefers-reduced-motion`: emulate once (`tab.page.emulateMediaFeatures` or
   CDP) and confirm the intro still completes and tiles render.

## Definition of done

- [ ] Toggle: no grey fringes at DPR 1 / 1.5 / 2, rest/hover/focus, both themes.
- [ ] Welcome/Bienvenue: 100%-speed entry from borders → exponential decay →
      ~1s legible center → exponential acceleration out (mirrored pair).
- [ ] CMS capitals thinner; tails match; stacked "Content/Management/System"
      block centered under "Nomad" (≤2px) once unfolded.
- [ ] Every repo with HTML shows a miniature; hover never shows square
      corners outside the rounded tile.
- [ ] typecheck + full test suite green; no backend changes; no new deps.
