# Visual Rework — v2 brief (review verdicts + fixes)

Supersedes the B / C2 / A-disc parts of `visual-rework-fix-plan.md`. Everything
else from v1 stands. Same house rules: durations via `calc(Nms * var(--speed))`,
JS timers in IntroOverlay.tsx mirror the CSS, reduced-motion fallbacks in the
same file, no new deps/fonts, match the comment style.

Environment notes: user's stack = vite on **[::1]:5173** + workerd on 8787.
A second vite (executor's) runs on **127.0.0.1:5174** — use it for browser
verification (the in-app browser can't reach IPv6-only 5173). GitHub token in
the local session is expired → `/repositories` live E2E stays blocked; D is
accepted on code review + unit tests (verdict below).

---

## Verdicts on v1 steps

### A — toggle glitch: PASS
`border` removed, inset ring in `box-shadow`, `:focus-visible` re-asserts the
ring (global.css:332-357). Verified live at deviceScaleFactor 1.5 (which the
executor could not set): clean half/half disc, no grey crescent/nub at rest
and hover, light theme; dark theme identical rule. Structurally DPR-proof.

### B — welcome/bienvenue trajectory: FAILED (superseded by fix E below)
Implementation matches the v1 letter but the v1 profile was wrong: sampled
velocity (rAF, 1280px viewport) shows the word at **0 px/s** at ~1.0-1.2s and
~2.2-2.4s (expo-out fully settles before the linear crawl starts), then a
53 px/s crawl, then expo-in. Three visibly disjoint motions — exactly the
user's complaint ("1st arrival, 2nd middle, 3rd leaving"). The plan must own
this; fix E re-specifies the profile with velocity continuity.

### C — CMS type + centering: FAILED on centering (superseded by fix F)
- Thinner face: PASS (Noto Serif Light on Linux, weight 300; tails inherit
  family+weight — correct extension).
- Tighter lockup: PASS (gap 0.02em, pitch 0.92, measured 1.8px gap).
- Centering: FAILED. The executor centered the unfolded block's *bounding
  box* (mathematically ≤0.6px off), but because rows are left-aligned and the
  longest row ("Management") ≈ "Nomad"'s width, the finished lockup reads as
  a left column hanging off Nomad's left edge (measured: straight left edge
  at 510 vs Nomad 513-767, ragged right). User verdict: "too aligned on the
  left". Fix F switches to per-row centering.

### D — thumbnails + hover corners: PASS (with environment caveat)
- `clip-path: inset(0 round var(--radius-lg))` on `.repo-thumb`
  (RepoTile.css:19) with a why-comment. Not reproducible headless (as v1
  predicted) — needs the user's GPU for final confirmation.
- Tier chain implemented faithfully (RepoTile.tsx:167-234): live URL →
  repo-render (listPages→pickPreviewPage→getPage→buildSrcDoc srcDoc, one
  attempt) → monogram; `buildSrcDoc` extracted to services/preview and
  EditorView imports it (clean cutover, no duplicate sanitizer); 3 new unit
  tests. Live E2E blocked by expired GitHub token — acceptable, called out.

---

## Fix E — one continuous drift (no dead stops)

File: `packages/frontend/src/features/intro/IntroOverlay.css` only. No TS
timeline changes (WELCOME_SCENE_MS stays 3450).

Root cause of the "3 animations" read: expo-out `(0.16,1,0.3,1)` decays to
~0 velocity before 35%, so the linear segment starts from a standstill. The
fix is **velocity continuity at both joins**: the entry must still be moving
at (≈) the middle drift speed when it hands over, and the exit must start at
(≈) that same speed. Verified by numeric simulation of the bezier timeline
below: entry-end 59 px/s, middle 58, exit-start 61 (1280px viewport) — no
dead stop anywhere, profile 2182 → 59 → 58 → 61 → 2287 px/s.

Replace the two keyframe blocks (lines 96-146) and the comment (90-95):

```css
/* One continuous journey: the entry decays exponentially but hands over
   still moving (~the middle drift speed), the center is a slow legible
   crawl (~1s scaled), and the exit leaves at that same speed and
   accelerates exponentially. Velocity is continuous at both joins — no
   dead stop, so it reads as a single motion, not three animations. */
@keyframes intro-welcome-drift {
  0% {
    opacity: 0;
    transform: translateX(-55vw);
    animation-timing-function: cubic-bezier(0.08, 0.55, 0.5, 0.95); /* expo-out that still moves at the join */
  }
  7% { opacity: 0.78; }
  35% {
    transform: translateX(-2.25vw);
    animation-timing-function: linear; /* ≈1s legible crawl across the center */
  }
  65% {
    transform: translateX(2.25vw);
    animation-timing-function: cubic-bezier(0.5, 0.05, 0.85, 0.3); /* expo-in starting at the crawl speed */
  }
  92% { opacity: 0.78; }
  100% { opacity: 0; transform: translateX(58vw); }
}
/* intro-bienvenue-drift: identical with every X sign flipped. */
```

**Acceptance (numeric, not vibes):** clear `sessionStorage['cms.intro-seen']`,
sample `.intro__word--welcome` rect.x per rAF for 3.4s, compute px/s at
1280px. Must hold: (1) no sample with |v| < 30 px/s between 200ms and 3100ms;
(2) velocity at 35%±50ms and 65%±50ms within 1.25× of the middle velocity;
(3) monotone decay on entry, monotone growth on exit; (4) Bienvenue mirrors
(lefts sum constant). Screenshot at ~1.5s shows the word legible near center.

---

## Fix F — per-row centered CMS lockup

Files: `IntroOverlay.css`, `IntroOverlay.tsx`.

The stacked column becomes three rows each centered on "Nomad"'s center axis
(classical centered lockup: Content / Management / System). The seam where a
tail emerges must stay at the capital's right edge *in its original
(untranslated) position* — otherwise the unfold would visibly jump.

### CSS (IntroOverlay.css)
1. `.intro__acronym` (218-230): `align-items: baseline` → `center` (rows are
   now independent centered lines; baseline alignment of shifted rows is
   meaningless). Everything else unchanged.
2. `.intro__acronym-word` (250-258): `display: inline-flex` → `inline-block`
   (its width must be exactly the capital's advance; flex would work today
   only by accident of the abs tail).
3. `.intro__acronym-tail` (260-280): `left: 100%` →
   `left: calc(100% - var(--sx, 0px));` — cancels the word's translate so the
   tail's visual origin stays at the capital's original right edge. Keep the
   `-0.04em` margin-left and everything else.
4. `.intro--stacked .intro__acronym-word` (282-284): unchanged.
5. Reduced-motion block (~332-369): confirm the existing rule still applies
   `transform: translate(var(--sx, 0px), var(--sy, 0px))` to the words and
   `transition: none` to the tails (it did in v1; keep it — the new `left`
   calc makes reduced-motion rows centered too, for free).

### TS (IntroOverlay.tsx, measureStackOffsets 87-124)
Row width is still `rect.width + tail.scrollWidth` (seam at the capital's
right edge ⇒ unfolded row = capital + tail). Change only the target:

```ts
// Each row centers on "Nomad"'s center axis (classic centered lockup);
// the tail's left calc() keeps the unfold seam at the capital's original
// right edge, so centering never moves the seam.
rows.forEach((row, k) => {
  row.word.style.setProperty('--sx', `${(center - row.rowWidth / 2 - row.left).toFixed(2)}px`);
  row.word.style.setProperty('--sy', `${(k * line).toFixed(2)}px`);
});
```

Delete the now-wrong `blockWidth`/`targetLeft` lines and update the doc
comments (87-92, and the "left-aligned column" wording in the component
comment 51-53) to "rows centered under Nomad".

**Acceptance:** freeze at the unfolded state (reload with cleared
sessionStorage, wait WELCOME_SCENE_MS + NOMAD_WORDS_AT_MS + 1s): for each of
the three `.intro__acronym-word` rects, `|rowCenter − nameCenter| ≤ 2px`;
tail seam: the visible join between capital and tail shows no gap/overlap
(screenshot close-up); "Nomad" never moves; stack pitch unchanged (0.92).

---

## Fix G — diagonal black/white divider on the theme toggle

File: `packages/frontend/src/styles/global.css` (332-357).

`conic-gradient(#111 0 50%, #fff 0)` splits at 0deg/180deg = vertical seam.
Rotate the start angle by a half-turn so the seam runs diagonally
(bottom-left → top-right):

```css
background: conic-gradient(from 180deg, #111 0 50%, #fff 0);
```

(`from 180deg` puts the color boundary on the 45°↔225° axis; `from 135deg`
is equally acceptable if it reads better in the close-up — pick one from the
screenshot, not from theory.) Keep the inset ring, hover and focus rules
untouched. Update the comment at 330-331 to mention the diagonal split.

**Acceptance:** selector screenshots of `.theme-toggle` on `/login` and in
the header, light + dark, DPR 1 and 1.5: the black/white boundary is a
straight diagonal, disc still clean (no fringes — regression check of A).

---

## Verification protocol (end of turn)

1. `npm run typecheck`, `npm test` (root) — green.
2. Browser on 127.0.0.1:5174: E's numeric velocity acceptance; F's per-row
   centering numbers + seam close-up; G's screenshots; A regression at
   DPR 1.5.
3. Replay the intro twice (light + dark) end-to-end and confirm the welcome
   → nomad handoff timing is unchanged (nomad appears as the words exit).

## Definition of done

- [ ] E: drift reads as one motion (numeric acceptance above).
- [ ] F: three centered rows under Nomad, ≤2px each, seam intact.
- [ ] G: diagonal divider, both themes, no fringe regression.
- [ ] typecheck + tests green; no other files touched.
