/**
 * SCROLL HINT — the deck's "what happens NEXT" affordance.
 *
 * The deck is a stack of fixed, viewport-filling views; each one scrolls
 * INTERNALLY first and only hands the wheel back to the page (the track)
 * at its inner edges — where one more gesture fires the particle morph
 * and swaps the whole section. That moment is invisible today, so this
 * module floats a quiet line at the bottom-centre of the viewport the
 * instant it becomes true: "Keep scrolling — next → <destination>", and
 * mirrored at the top edge, "Keep scrolling up — back → <destination>".
 *
 * Complementary to scrollIndicator.ts, never a competitor: the right-edge
 * capsule says where you ARE, this says what the next scroll DOES. Both
 * are driven from the same deck callbacks (onViewTargeted / onViewLanded)
 * so rail, indicator, accent and hint can never disagree.
 *
 * It is an OBSERVER of the deck, not a new input path: it listens to the
 * active view's scroll (passive), a ResizeObserver on that view's box and
 * the overlay lock's edges. Its one input is its own button, which routes
 * through the very same goTo the rail and the indicator use — a click
 * does exactly what the scroll would have done.
 *
 * No hardcoded palette hex: the chip translucency rides var(--mx-stage)
 * (the body token), the kicker and focus ring ride var(--mx-accent), and
 * the neutral ink is inkOn(view.stage) — the same luminance flip the
 * scroll indicator uses — pushed as --sh-ink on the root.
 */
import { gsap } from 'gsap';
import { inkOn } from './themes';
import { onOverlayChange, overlayOpen } from './overlayLock';
import '../styles/scrollHint.css';

export interface ScrollHintView {
  id: string;
  /** Human label from the content data — the destination we announce. */
  label: string;
  /** Hex stage behind this view — decides the neutral ink. */
  stage: string;
  /** The view root — the deck panel that is its own inner scroller. */
  el: HTMLElement;
}

export interface ScrollHintOpts {
  views: ScrollHintView[];
  reduced: () => boolean;
  /** The hint was clicked — route through the same goTo path as the rail. */
  onSelect: (id: string, index: number) => void;
  /**
   * An element the hint must never cover (the footer, which rides the
   * LAST view's inner scroll). Consulted live: while its box overlaps the
   * hint's band the hint stays away.
   */
  avoid?: () => HTMLElement | null;
}

export interface ScrollHint {
  /** The root — a body-level fixed element. */
  readonly el: HTMLElement;
  /** A view became the navigation target (morph starting) — duck out. */
  setTarget(id: string): void;
  /** That view landed — re-arm on its scroller and re-evaluate. */
  setLanded(id: string): void;
  /** Allowed to appear once the intro completes. */
  reveal(): void;
  destroy(): void;
}

/** Distance from an inner edge that still counts as "at the edge" (px). */
const EDGE = 24;
/** Wait after a scroll tick before appearing — no flashing mid-flick. */
const SETTLE = 130;
/** Longer beat after a section lands: let the entrance breathe first. */
const ARRIVE = 420;
/**
 * Safety net for the morph latch. A full morph lands in ~2.3s (disperse +
 * swarm + converge), so this only ever fires if the deck took a path that
 * targets a view without landing it — the hint un-latches instead of
 * staying hidden for good.
 */
const GRACE = 6000;

type Dir = 'down' | 'up';

interface Want {
  dir: Dir;
  /** Index of the view one scroll away. */
  dest: number;
}

function same(a: Want | null, b: Want | null): boolean {
  if (!a || !b) return a === b;
  return a.dir === b.dir && a.dest === b.dest;
}

export function initScrollHint(opts: ScrollHintOpts): ScrollHint {
  const { views } = opts;
  const N = views.length;

  /* ------------------------------- the DOM -------------------------------- */

  const root = document.createElement('div');
  root.className = 'mx-sh';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mx-sh-btn';

  const lead = document.createElement('span');
  lead.className = 'mx-sh-lead';

  const dest = document.createElement('span');
  dest.className = 'mx-sh-dest';

  const kicker = document.createElement('span');
  kicker.className = 'mx-sh-kicker';

  /* the chevron bobs — the wrap carries the loop so the glyph keeps its
     own rotation transform (and the glyph is decoration, never announced) */
  const chevWrap = document.createElement('span');
  chevWrap.className = 'mx-sh-chev-wrap';
  chevWrap.setAttribute('aria-hidden', 'true');
  const chev = document.createElement('span');
  chev.className = 'mx-sh-chev';
  chevWrap.appendChild(chev);

  const label = document.createElement('span');
  label.className = 'mx-sh-label';

  dest.appendChild(kicker);
  dest.appendChild(chevWrap);
  dest.appendChild(label);
  btn.appendChild(lead);
  btn.appendChild(dest);
  root.appendChild(btn);
  document.body.appendChild(root);

  /* blank until the deck lands and the intro releases it */
  gsap.set(root, { autoAlpha: 0 });

  /* ------------------------------- the state ------------------------------ */

  let active = -1;
  /** True from "a view was targeted" to "that view landed" — morph time. */
  let busy = true;
  let revealed = false;
  let current: Want | null = null;
  let settleT: ReturnType<typeof setTimeout> | null = null;
  let graceT: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  let dead = false;

  btn.addEventListener('click', () => {
    if (!current) return;
    const v = views[current.dest];
    opts.onSelect(v.id, current.dest);
  });

  /* ------------------------------ the reading ----------------------------- */

  /** The footer (last view) must keep the bottom band to itself. */
  function bandClear(): boolean {
    const node = opts.avoid?.();
    if (!node) return true;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true; /* in a hidden view */
    const band = Math.min(140, window.innerHeight * 0.22);
    return !(r.bottom > window.innerHeight - band && r.top < window.innerHeight);
  }

  /** What the next scroll would do, or null when the hint has no business. */
  function want(): Want | null {
    if (dead || !revealed || busy || active < 0) return null;
    if (overlayOpen()) return null; /* reading room / maintainer / lightbox */
    const el = views[active].el;
    const max = el.scrollHeight - el.clientHeight;
    const top = el.scrollTop;
    /* a view that fits without inner scrolling satisfies BOTH edges —
       downward wins, that is the direction of travel */
    let w: Want | null = null;
    if (top >= max - EDGE && active < N - 1) w = { dir: 'down', dest: active + 1 };
    else if (top <= EDGE && active > 0) w = { dir: 'up', dest: active - 1 };
    if (w && !bandClear()) return null; /* the footer is standing there */
    return w;
  }

  /* ------------------------------ the painting ---------------------------- */

  function paint(w: Want): void {
    const to = views[w.dest];
    const down = w.dir === 'down';
    lead.textContent = down ? 'Keep scrolling' : 'Keep scrolling up';
    kicker.textContent = down ? 'next' : 'back';
    label.textContent = to.label;
    btn.setAttribute('aria-label', 'Go to ' + to.label);
    btn.title = 'Go to ' + to.label;
    root.classList.toggle('is-up', !down);
    /* neutral ink for the stage we are standing on, not the destination */
    root.style.setProperty('--sh-ink', inkOn(views[active].stage));
  }

  function show(w: Want | null): void {
    if (same(w, current)) return;
    const had = current !== null;
    current = w;
    gsap.killTweensOf(root);
    if (!w) {
      root.classList.remove('is-live'); /* stops the idle bob */
      if (opts.reduced()) gsap.set(root, { autoAlpha: 0, y: 0 });
      else gsap.to(root, { autoAlpha: 0, y: 8, duration: 0.18, ease: 'power2.in' });
      return;
    }
    paint(w);
    root.classList.add('is-live');
    if (had || opts.reduced()) {
      /* already on screen (copy swap) or motion off: no slide, just be there */
      gsap.set(root, { autoAlpha: 1, y: 0 });
      return;
    }
    gsap.fromTo(
      root,
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power2.out' },
    );
  }

  /* ------------------------------- the pulse ------------------------------ */

  function clearSettle(): void {
    if (settleT) {
      clearTimeout(settleT);
      settleT = null;
    }
  }

  function clearGrace(): void {
    if (graceT) {
      clearTimeout(graceT);
      graceT = null;
    }
  }

  /**
   * Hiding is immediate (the truth stopped being true); appearing waits a
   * beat so a flick through a section never flashes the chip. The timer is
   * a throttle, not a debounce — continuous momentum scrolling still gets
   * its hint once the edge holds for SETTLE.
   */
  function evaluate(delay: number): void {
    const w = want();
    if (!w) {
      clearSettle();
      show(null);
      return;
    }
    if (same(w, current)) {
      clearSettle();
      return;
    }
    if (delay <= 0) {
      clearSettle();
      show(w);
      return;
    }
    if (settleT) return;
    settleT = setTimeout(() => {
      settleT = null;
      show(want());
    }, delay);
  }

  /* one read per frame while a scroll is running */
  function tick(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      evaluate(SETTLE);
    });
  }

  const onScroll = (): void => tick();
  const ro = new ResizeObserver(() => tick());
  /* an overlay opening hides us the same frame (evaluate hides with no
     delay); closing goes through the usual settle before coming back */
  const offOverlay = onOverlayChange(() => evaluate(SETTLE));

  /* ------------------------------- the wiring ----------------------------- */

  let bound: HTMLElement | null = null;

  function bind(i: number): void {
    const el = views[i].el;
    if (bound === el) return;
    bound?.removeEventListener('scroll', onScroll);
    ro.disconnect();
    bound = el;
    el.addEventListener('scroll', onScroll, { passive: true });
    /* the panel box (viewport changes) AND its content column (async
       content growing under us) both move the bottom edge */
    ro.observe(el);
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) ro.observe(child);
    }
  }

  function setTarget(id: string): void {
    const i = views.findIndex((v) => v.id === id);
    if (i < 0) return;
    active = i;
    busy = true; /* a morph owns the screen until the view lands */
    clearSettle();
    show(null);
    bind(i);
    clearGrace();
    graceT = setTimeout(() => {
      graceT = null;
      busy = false; /* no landing came — never stay hidden for good */
      evaluate(ARRIVE);
    }, GRACE);
  }

  function setLanded(id: string): void {
    const i = views.findIndex((v) => v.id === id);
    if (i < 0) return;
    clearGrace();
    active = i;
    busy = false;
    bind(i);
    evaluate(ARRIVE);
  }

  function reveal(): void {
    if (revealed) return;
    revealed = true;
    evaluate(ARRIVE);
  }

  return {
    el: root,
    setTarget,
    setLanded,
    reveal,
    destroy() {
      dead = true;
      clearSettle();
      clearGrace();
      if (frame) cancelAnimationFrame(frame);
      offOverlay();
      ro.disconnect();
      bound?.removeEventListener('scroll', onScroll);
      bound = null;
      gsap.killTweensOf(root);
      root.remove();
    },
  };
}
