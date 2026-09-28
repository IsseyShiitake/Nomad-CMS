import { useEffect, useRef } from 'react';
import './Background.css';

/** How much of the remaining distance to the pointer is covered per
 *  16.7ms frame. Small enough to feel like the light has mass, large
 *  enough that it never feels laggy. */
const LERP_PER_FRAME = 0.075;

/** Snap instead of animating once this close to the target (px). */
const SETTLE_EPSILON = 0.4;

/** Resting offset of the key light from the viewport centre, in vw/vh —
 *  matches the value baked into Background.css so a browser that never
 *  runs this effect (reduced motion, no JS) shows the same composition. */
const REST = { x: -0.11, y: -0.14 };

/**
 * Ambient background layer: a directional pastel field, a key light that
 * trails the pointer, three slowly wandering blurred orbs, a vignette and
 * a faint grain. Purely decorative (aria-hidden, pointer-events: none) and
 * rendered fixed at z-index 0, behind every app surface.
 *
 * The pointer light is deliberately written as a `transform` on its own
 * element rather than as an animated gradient position or a filter: both
 * of those force the browser to re-rasterize a full-viewport layer every
 * frame, whereas a transform stays on the compositor. The rAF loop also
 * stops itself once the light settles, so an idle tab costs nothing.
 */
export function Background({ className }: { className?: string }) {
  const keyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = keyRef.current;
    if (!node) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motionQuery.matches) return; // the light stays parked at REST

    let frame = 0;
    let lastTime = 0;
    // Position and target in viewport-relative units (-0.5 … 0.5), so a
    // resize needs no conversion and the light keeps its composition.
    let currentX = REST.x;
    let currentY = REST.y;
    let targetX = REST.x;
    let targetY = REST.y;
    let hasPointer = false;

    const render = () => {
      node.style.transform = `translate3d(${(currentX * 100).toFixed(3)}vw, ${(
        currentY * 100
      ).toFixed(3)}vh, 0)`;
    };

    const tick = (time: number) => {
      const delta = lastTime ? Math.min(time - lastTime, 64) : 16.7;
      lastTime = time;
      // Frame-rate independent: the same visual settle at 60Hz or 144Hz.
      const amount = 1 - Math.pow(1 - LERP_PER_FRAME, delta / 16.7);
      currentX += (targetX - currentX) * amount;
      currentY += (targetY - currentY) * amount;

      const settled =
        Math.abs(targetX - currentX) < SETTLE_EPSILON / 100 &&
        Math.abs(targetY - currentY) < SETTLE_EPSILON / 100;

      if (settled) {
        currentX = targetX;
        currentY = targetY;
        render();
        frame = 0; // parked — the next pointermove restarts the loop
        return;
      }

      render();
      frame = window.requestAnimationFrame(tick);
    };

    const wake = () => {
      if (!frame) {
        lastTime = 0;
        frame = window.requestAnimationFrame(tick);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      // Touch has no resting pointer position to track; leave the light
      // where it is rather than pinning it under a fingertip.
      if (event.pointerType === 'touch') return;
      hasPointer = true;
      targetX = event.clientX / window.innerWidth - 0.5;
      targetY = event.clientY / window.innerHeight - 0.5;
      wake();
    };

    // No pointer yet (touch device, or the tab has not been moved into):
    // let the light drift home once from REST so the field is not static
    // on arrival, then park.
    const onFirstPaint = () => {
      if (hasPointer) return;
      targetX = REST.x + 0.06;
      targetY = REST.y + 0.05;
      wake();
    };

    render();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    const settleTimer = window.setTimeout(onFirstPaint, 900);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.clearTimeout(settleTimer);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };
  }, []);

  return (
    <div className={'ambient' + (className ? ' ' + className : '')} aria-hidden="true">
      <div className="ambient__dream" />
      <div className="ambient__key" ref={keyRef} />
      <span className="ambient__orb ambient__orb--1" />
      <span className="ambient__orb ambient__orb--2" />
      <span className="ambient__orb ambient__orb--3" />
      <div className="ambient__vignette" />
      <div className="ambient__grain" />
    </div>
  );
}
