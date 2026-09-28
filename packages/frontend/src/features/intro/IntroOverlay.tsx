import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import './IntroOverlay.css';

/** sessionStorage key marking the intro as seen for this tab session. */
const INTRO_SEEN_KEY = 'cms.intro-seen';

type IntroPhase = 'welcome' | 'nomad' | 'closing';

/* Timeline (ms), pre-scaled by the global 0.7 motion factor — the CSS side
   derives every duration from --speed (theme.css); these constants mirror
   the same scaling. The welcome scene runs WELCOME_SCENE_MS in total; the
   nomad timers are relative to that scene's own start. */
const WELCOME_SCENE_MS = 3450; // 3290ms full journey (expo-in → 1s legible center → expo-out) + buffer
const NOMAD_STACK_AT_MS = 1470; // blur-fade (770ms) + 0.7s hold, then stack
const NOMAD_WORDS_AT_MS = 2380; // stack glide (490ms) + beat, then the tails unfold
const NOMAD_CLOSE_AT_MS = 3780; // tails (560ms) + ~0.7s hold, then fade
const CLOSE_FADE_MS = 420;

/** Scripted length of the sequence, handed to CSS as --intro-total so the
 *  progress hairline and these timers share one source of truth and cannot
 *  drift apart when the timeline is retuned. */
const INTRO_TOTAL_MS = WELCOME_SCENE_MS + NOMAD_CLOSE_AT_MS;

/** Upper bound on waiting for webfonts before the sequence starts anyway.
 *  A stalled or blocked font request must never hold the intro hostage. */
const FONT_READY_TIMEOUT_MS = 1200;

const NOMAD_LETTERS = ['N', 'o', 'm', 'a', 'd'];
/** Each word starts with the acronym letter; the tail slides out from
 * underneath it — "C"+"ontent", "M"+"anagement", "S"+"ystem". */
const ACRONYM_WORDS = ['Content', 'Management', 'System'];

function readIntroSeen(): boolean {
  try {
    return sessionStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    sessionStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    /* storage unavailable (private mode etc.) — intro replays next tab */
  }
}

/**
 * Cinematic two-scene intro overlay, rendered above the app over its own
 * opaque wash of the Lumen field, so nothing behind it shows through while
 * the story plays.
 *
 * Scene 1 — "Welcome / Bienvenue" drift across the screen in opposite
 * directions along a hairline rail: a continuous fast → slow → fast journey
 * (entering at the slide-in speed, decelerating through the center without
 * ever stopping, then accelerating out the opposite side, mirroring the
 * entry). Each word brightens to full ink as it crosses the center, where
 * the key light is, and dims again as it leaves.
 * Scene 2 — "Nomad" (italic serif) and "CMS" (upright capitals, quieter,
 * smaller) materialize together out of a soft blur over a single bloom of
 * light. The three words then glide — as whole word spans, so nothing
 * reflows and "Nomad" never moves — into a centered lockup, each row on
 * "Nomad"'s center axis, and each word's lowercase tail slides out from
 * behind its capital, in the capital's own serif at its own size.
 *
 * A 1px progress hairline along the bottom edge fills over exactly this
 * timeline: it shows the sequence is finite and that clicking shortens it.
 *
 * Nothing moves until the overlay carries `.intro--armed`, which the mount
 * effect sets once the display face is available (capped, so a stalled font
 * fetch can never block it). Until then the wash alone is painted — which is
 * also what the app looks like if the sequence is skipped.
 * The `cms.intro-seen` sessionStorage key makes returning tabs complete
 * immediately (onDone fires from the mount effect, no replay).
 */
export function IntroOverlay({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<IntroPhase>('welcome');
  const [nomadVisible, setNomadVisible] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [wordsOut, setWordsOut] = useState(false);
  /** False until the display face is available. The overlay paints its
   *  opaque wash immediately either way, so the app behind it is never
   *  visible during the wait. */
  const [armed, setArmed] = useState(false);

  const doneRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const letterRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const nameRef = useRef<HTMLSpanElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    markIntroSeen();
    onDoneRef.current();
  }, []);

  const skip = useCallback(() => {
    if (doneRef.current || phase === 'closing') return;
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
    setPhase('closing');
    timersRef.current.push(window.setTimeout(finish, CLOSE_FADE_MS));
  }, [phase, finish]);

  /* Measure the stacked row positions so each acronym word glides — as a
     whole span, letter + tail together — onto "Nomad"'s center axis: a
     classic centered lockup (Content / Management / System). The offsets
     go on the word wrapper because CSS custom properties inherit down,
     not up. Runs once, right before the transform starts, while the
     tails are still clipped (max-width: 0) but laid out and measurable. */
  const measureStackOffsets = useCallback(() => {
    const letters = letterRefs.current;
    const name = nameRef.current;
    const anchor = letters[0];
    if (!anchor || !name) return;
    // Row pitch of the stacked column: just under the capital's line box,
    // so the three rows read as one tight lockup instead of a tall list.
    const line = anchor.getBoundingClientRect().height * 0.92;
    const nameRect = name.getBoundingClientRect();
    const center = nameRect.left + nameRect.width / 2;
    // Unfolded row width: the in-flow span lays out just the capital (the
    // tail is absolutely positioned); tail.scrollWidth is the clipped
    // nowrap content width, measurable even at max-width: 0.
    const rows: Array<{ word: HTMLElement; left: number; rowWidth: number }> = [];
    letters.forEach((el) => {
      if (!el) return;
      const word = el.closest<HTMLElement>('.intro__acronym-word');
      if (!word) return;
      const tail = word.querySelector<HTMLElement>('.intro__acronym-tail');
      const rect = word.getBoundingClientRect();
      rows.push({ word, left: rect.left, rowWidth: rect.width + (tail ? tail.scrollWidth : 0) });
    });
    if (rows.length === 0) return;
    // Each row centers on "Nomad"'s center axis (classic centered
    // lockup); the tail's left calc() keeps the unfold seam pinned, so
    // centering never moves the seam.
    rows.forEach((row, k) => {
      row.word.style.setProperty('--sx', `${(center - row.rowWidth / 2 - row.left).toFixed(2)}px`);
      row.word.style.setProperty('--sy', `${(k * line).toFixed(2)}px`);
    });
  }, []);

  /* Arm the sequence only once the display face is actually available.

     The stacked CMS lockup is MEASURED, not laid out: measureStackOffsets
     reads each capital's box and its clipped tail's scrollWidth, then
     centres the row on "Nomad"'s axis. If Fraunces swaps in after that
     measurement, every row is centred on fallback metrics and visibly
     jumps when the real face lands — the exact artefact the centring was
     tuned away. Gating on document.fonts.ready removes the race.

     The wait is capped at FONT_READY_TIMEOUT_MS and raced, never awaited
     alone, so a blocked or stalled font request degrades to today's
     behaviour instead of holding the intro (and therefore the router)
     hostage. A returning tab session skips all of it. */
  useEffect(() => {
    if (readIntroSeen()) {
      // Returning tab session: mount, but complete immediately.
      finish();
      return;
    }
    let cancelled = false;
    const fontReady = document.fonts?.ready ?? Promise.resolve();
    const cap = new Promise<void>((resolve) => {
      window.setTimeout(resolve, FONT_READY_TIMEOUT_MS);
    });
    void Promise.race([fontReady, cap]).then(() => {
      if (!cancelled) setArmed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [finish]);

  useEffect(() => {
    if (!armed) return;
    const schedule = (fn: () => void, ms: number) => {
      timersRef.current.push(window.setTimeout(fn, ms));
    };
    schedule(() => {
      setNomadVisible(true);
      setPhase('nomad');
    }, WELCOME_SCENE_MS);
    schedule(() => {
      measureStackOffsets();
      setStacked(true);
    }, WELCOME_SCENE_MS + NOMAD_STACK_AT_MS);
    schedule(() => setWordsOut(true), WELCOME_SCENE_MS + NOMAD_WORDS_AT_MS);
    schedule(() => setPhase('closing'), WELCOME_SCENE_MS + NOMAD_CLOSE_AT_MS);
    schedule(finish, WELCOME_SCENE_MS + NOMAD_CLOSE_AT_MS + CLOSE_FADE_MS);
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current = [];
    };
  }, [armed, finish, measureStackOffsets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [skip]);

  return (
    <div
      className={
        'intro intro--' +
        phase +
        (armed ? ' intro--armed' : '') +
        (nomadVisible ? ' intro--nomad-on' : '') +
        (stacked ? ' intro--stacked' : '') +
        (wordsOut ? ' intro--words' : '')
      }
      // The CSS custom property is not in React's CSSProperties index
      // signature; the assertion is the standard escape hatch and adds no
      // runtime cost.
      style={{ '--intro-total': `${INTRO_TOTAL_MS}ms` } as CSSProperties}
      onClick={skip}
    >
      <div className="intro__scene intro__welcome" aria-hidden="true">
        <span className="intro__word intro__word--welcome">Welcome</span>
        <span className="intro__word intro__word--bienvenue">Bienvenue</span>
      </div>

      <div className="intro__scene intro__nomad" aria-hidden="true">
        <div className="intro__title">
          <span className="intro__name" ref={nameRef}>
            {NOMAD_LETTERS.map((letter, index) => (
              <span key={index} className="intro__letter">
                {letter}
              </span>
            ))}
          </span>
          <span className="intro__acronym">
            {ACRONYM_WORDS.map((word, index) => (
              <span key={word} className="intro__acronym-word">
                <span
                  className="intro__acronym-letter"
                  ref={(el) => {
                    letterRefs.current[index] = el;
                  }}
                >
                  {word.charAt(0)}
                </span>
                <span className="intro__acronym-tail" aria-hidden="true">
                  {word.slice(1)}
                </span>
              </span>
            ))}
          </span>
        </div>
      </div>

      <p className="intro__hint">click to continue · cliquez pour continuer</p>
      <span className="intro__progress" aria-hidden="true" />
    </div>
  );
}
