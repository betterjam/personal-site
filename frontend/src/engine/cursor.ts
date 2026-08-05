/**
 * Adaptive pointer, ported from the mockup: a precision dot plus a lagging
 * ring, both recolored through the root --mx-accent so section changes
 * re-tint it for free. Gate: fine pointer AND motion allowed; otherwise the
 * native cursor stays and none of this runs. DOM is aria-hidden.
 */
import { gsap } from 'gsap';

type QuickTo = (value: number) => void;

export interface CursorController {
  destroy(): void;
}

function onMq(m: MediaQueryList, fn: () => void): () => void {
  if (typeof m.addEventListener === 'function') {
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }
  // Legacy Safari fallback.
  (m as MediaQueryList & { addListener(cb: () => void): void }).addListener(fn);
  return () =>
    (m as MediaQueryList & { removeListener(cb: () => void): void }).removeListener(fn);
}

export function initCursor(): CursorController {
  const root = document.documentElement;
  const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mqFine = window.matchMedia('(pointer: fine)');

  let active = false;
  let hot = false;
  let dot: HTMLDivElement | null = null;
  let ring: HTMLDivElement | null = null;
  let dotX: QuickTo | null = null;
  let dotY: QuickTo | null = null;
  let ringX: QuickTo | null = null;
  let ringY: QuickTo | null = null;

  function allowed(): boolean {
    return mqFine.matches && !mqReduced.matches;
  }

  function onMove(e: PointerEvent): void {
    if (!dotX || !dotY || !ringX || !ringY) return;
    dotX(e.clientX);
    dotY(e.clientY);
    ringX(e.clientX);
    ringY(e.clientY);
    root.classList.add('mx-cur-vis');
  }
  function onOver(e: Event): void {
    if (!ring) return;
    const t = e.target as Element | null;
    const on = !!(t && t.closest && t.closest('button, a, summary'));
    if (on === hot) return;
    hot = on;
    ring.classList.toggle('is-hot', on);
    gsap.to(ring, { scale: on ? 1.35 : 1, duration: 0.25, ease: 'power3.out', overwrite: 'auto' });
  }
  function onLeave(): void {
    root.classList.remove('mx-cur-vis');
  }
  function onEnter(): void {
    root.classList.add('mx-cur-vis');
  }

  function enable(): void {
    if (active) return;
    active = true;
    dot = document.createElement('div');
    dot.className = 'mx-cur-dot';
    ring = document.createElement('div');
    ring.className = 'mx-cur-ring';
    dot.setAttribute('aria-hidden', 'true');
    ring.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ring);
    document.body.appendChild(dot);
    gsap.set([dot, ring], { xPercent: -50, yPercent: -50, x: -100, y: -100 });
    dotX = gsap.quickTo(dot, 'x', { duration: 0.07, ease: 'power4.out' });
    dotY = gsap.quickTo(dot, 'y', { duration: 0.07, ease: 'power4.out' });
    ringX = gsap.quickTo(ring, 'x', { duration: 0.14, ease: 'power4.out' });
    ringY = gsap.quickTo(ring, 'y', { duration: 0.14, ease: 'power4.out' });
    root.classList.add('mx-has-pointer');
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerover', onOver);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointerenter', onEnter);
  }

  function disable(): void {
    if (!active) return;
    active = false;
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerleave', onLeave);
    root.removeEventListener('pointerenter', onEnter);
    if (dot && ring) {
      gsap.killTweensOf([dot, ring]);
      ring.remove();
      dot.remove();
    }
    dot = ring = null;
    dotX = dotY = ringX = ringY = null;
    root.classList.remove('mx-has-pointer');
    root.classList.remove('mx-cur-vis');
    hot = false;
  }

  function sync(): void {
    if (allowed()) enable();
    else disable();
  }

  const offFine = onMq(mqFine, sync);
  const offReduced = onMq(mqReduced, sync);
  sync();

  return {
    destroy() {
      offFine();
      offReduced();
      disable();
    },
  };
}
