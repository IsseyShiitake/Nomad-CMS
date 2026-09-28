import { useEffect, useRef, useState } from 'react';
import { subscribeGreetingHost, takeNextGreeting } from './index';
import type { GreetingRequest } from './index';
import './Greeting.css';

/* Timeline for one greeting (ms) — pre-scaled by the global 0.7 motion
   factor; Greeting.css fades via calc(400ms * --speed) = 280ms to match. */
const FADE_IN_MS = 280;
const HOLD_MS = 700;
const FADE_OUT_MS = 280;
/* One frame before fading in, so the initial opacity:0 state paints first. */
const PRE_FADE_MS = 30;

/**
 * Full-screen overlay that renders queued greetings one at a time:
 * fade in → hold → fade out → onDone → next. Fixed, non-interactive
 * (pointer-events: none), announced politely for screen readers.
 *
 * The timeline runs on refs so it survives effect re-runs and
 * StrictMode remounts; all timers are cleared on unmount, and any
 * request interrupted mid-greeting still settles its onDone callback
 * so callers never get stuck waiting.
 */
export function GreetingHost() {
  const [request, setRequest] = useState<GreetingRequest | null>(null);
  const [visible, setVisible] = useState(false);

  const timersRef = useRef<number[]>([]);
  const busyRef = useRef(false);
  const currentRef = useRef<GreetingRequest | null>(null);

  useEffect(() => {
    const timers = timersRef.current;

    const schedule = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };

    const clearTimers = () => {
      for (const id of timers.splice(0)) {
        window.clearTimeout(id);
      }
    };

    /** Render one greeting through its timeline, then drain the queue. */
    const show = (req: GreetingRequest) => {
      clearTimers();
      busyRef.current = true;
      currentRef.current = req;
      setRequest(req);
      setVisible(false);
      schedule(() => {
        setVisible(true);
        schedule(() => {
          setVisible(false);
          schedule(() => {
            currentRef.current = null;
            req.onDone?.();
            const next = takeNextGreeting();
            if (next) {
              show(next);
            } else {
              busyRef.current = false;
              setRequest(null);
            }
          }, FADE_OUT_MS);
        }, FADE_IN_MS + HOLD_MS);
      }, PRE_FADE_MS);
    };

    const pull = () => {
      if (busyRef.current) return;
      const next = takeNextGreeting();
      if (next) show(next);
    };

    const unsubscribe = subscribeGreetingHost(pull);

    // Pick up anything queued before the host mounted.
    pull();

    return () => {
      unsubscribe();
      clearTimers();
      // Interrupted mid-greeting: best-effort settle so callers proceed.
      const interrupted = currentRef.current;
      currentRef.current = null;
      busyRef.current = false;
      interrupted?.onDone?.();
      // Also clear the display so a StrictMode remount doesn't leave a
      // stale greeting rendered after its timer was torn down.
      setRequest(null);
      setVisible(false);
    };
  }, []);

  if (!request) return null;

  const fr = request.locale === 'fr';

  return (
    <div
      className={'greeting' + (visible ? ' greeting--visible' : '')}
      aria-live="polite"
    >
      <div className="greeting__kicker">{fr ? 'bienvenue' : 'welcome'}</div>
      <div className="greeting__text">
        {fr ? 'Bonjour' : 'Hello'} {request.name}
      </div>
    </div>
  );
}
