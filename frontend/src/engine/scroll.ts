/**
 * THE DECK — the seam-free replacement for the long-scroll spine.
 *
 * Every view (hub + sections) is a fixed, viewport-filling panel below the
 * sticky rail; exactly one wears .is-active (display model, as in mockup
 * 07). Each view root is its own overflow-y:auto scroller, so long content
 * scrolls INTERNALLY and native scroll chaining hands the wheel back to
 * the page at the inner edges — no overscroll-behavior anywhere.
 *
 * A body-height TRACK spacer (N * 100svh) keeps a real scrollbar. One
 * master ScrollTrigger maps track progress -> nearest slot index and snaps
 * the scrollbar onto slots. When the mapped index changes, the particle
 * morph IS the transition: the outgoing headline shatters in the outgoing
 * finish's swatches, the swarm recolors in flight, converges on the
 * incoming headline, the DOM crossfades and the entrance choreography
 * plays. Rapid scrolling retargets the same swarm mid-flight.
 *
 * Retrigger safety: one controller — { displayedIndex, targetIndex,
 * transitioning }. The track callback only ever REQUESTS a target;
 * programmatic navigation (goTo) tweens the scrollbar under a guard and
 * funnels through the same request path. request() no-ops on the current
 * target, so snap tweens and re-pins can never double-fire a morph.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { ParticleEngine } from './particles';

gsap.registerPlugin(ScrollTrigger);

export interface DeckView {
  id: string;
  /** The view root — fixed panel, its own inner scroller. */
  el: HTMLElement;
  /** The morph anchor. The deck owns its opacity/visibility. */
  headline: HTMLElement;
  themeId: string;
  /** Hex accent this view pushes to the root --mx-accent while targeted. */
  accent: string;
  /** Hex stage (page background behind the fixed panels). */
  stage: string;
  /** Extra hero elements the deck sweeps out with the headline (hub). */
  rise?: HTMLElement[];
  prepareEntrance(): void;
  playEntrance(): void;
  onEnter?(): void;
  onLeave?(): void;
}

export interface DeckOpts {
  reduced: () => boolean;
  particles: ParticleEngine;
  /** Where the track spacer div is appended. */
  trackHost: HTMLElement;
  /** View to display on boot (from the URL hash). */
  initialIndex: number;
  /** Skip the initial entrance (the hub intro owns the first paint). */
  skipInitialEntrance?: boolean;
  /** TEMPO.reveal — the incoming headline's fade at land. */
  revealSeconds: number;
  /** Called whenever a view becomes the navigation target (rail state). */
  onViewTargeted?: (id: string, index: number) => void;
  /**
   * Called when a view has LANDED (swarm converged / instant swap done),
   * including the boot seat. Pure observation — the deck's behaviour does
   * not depend on it (the scroll hint re-arms here).
   */
  onViewLanded?: (id: string, index: number) => void;
}

export interface Deck {
  readonly displayedIndex: number;
  readonly targetIndex: number;
  /** Tween the scrollbar to slot i and run the transition once. */
  goTo(index: number, entry?: 'top' | 'auto'): void;
  /** Resize: recompute slots, refresh triggers, keep the view stable. */
  refresh(): void;
  /** Reduced-motion preference flipped: settle/rebuild accordingly. */
  syncMotion(): void;
  destroy(): void;
}

const OVERLAY_HASH = /^#\//;

function clampIdx(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i));
}

/** True while a modal overlay owns scrolling (blog reading room). */
function scrollLocked(): boolean {
  return document.body.style.overflow === 'hidden';
}

function rectOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width >= 4 && r.height >= 4;
}

export function initDeck(views: DeckView[], opts: DeckOpts): Deck {
  const root = document.documentElement;
  const N = views.length;

  let displayedIndex = clampIdx(opts.initialIndex, N);
  let targetIndex = displayedIndex;
  let transitioning = false;

  let master: ScrollTrigger | null = null;
  let scrollTween: gsap.core.Tween | null = null;
  /** Deck-owned DOM tweens for the current transition leg. */
  let domFx: gsap.core.Timeline | null = null;
  /** Guards the track callback while slots are being recomputed. */
  let refreshing = false;

  /* --------------------------------- track -------------------------------- */

  const track = document.createElement('div');
  track.className = 'mx-track';
  track.setAttribute('aria-hidden', 'true');
  track.style.setProperty('--mx-views', String(N));
  opts.trackHost.appendChild(track);

  function slotY(i: number): number {
    if (N <= 1) return 0;
    return (i / (N - 1)) * ScrollTrigger.maxScroll(window);
  }

  function indexAt(progress: number): number {
    return clampIdx(Math.round(progress * (N - 1)), N);
  }

  function buildMaster(): void {
    master?.kill();
    const vars: ScrollTrigger.StaticVars = {
      start: 0,
      end: () => ScrollTrigger.maxScroll(window),
      onUpdate(self: ScrollTrigger) {
        if (scrollTween) return; /* programmatic travel — goTo already asked */
        if (refreshing) return; /* slot math in flux — the re-pin follows */
        if (scrollLocked()) return; /* overlay hash jumps must not remap */
        request(indexAt(self.progress), 'auto');
      },
    };
    if (!opts.reduced() && N > 1) {
      vars.snap = {
        snapTo: 1 / (N - 1),
        duration: { min: 0.2, max: 0.6 },
        delay: 0.08,
      };
    }
    master = ScrollTrigger.create(vars);
  }

  /* ------------------------------ DOM helpers ----------------------------- */

  function heroEls(v: DeckView): HTMLElement[] {
    return [v.headline, ...(v.rise ?? [])];
  }

  /** Clear deck-owned props so a view re-enters clean. */
  function restoreHero(v: DeckView): void {
    const els = heroEls(v);
    gsap.killTweensOf(els);
    gsap.set(els, { clearProps: 'opacity,visibility,transform' });
  }

  function killDomFx(): void {
    if (domFx) {
      domFx.kill();
      domFx = null;
    }
  }

  /**
   * Make view i the displayed one: class flip, stage re-tint, inner scroll
   * seeded by travel direction, loop gating. Entrance prep is separate so
   * morph/instant paths can order things around the headline sampling.
   */
  function swapDisplayed(i: number, entryBottom: boolean): void {
    const from = views[displayedIndex];
    const to = views[i];
    if (from !== to) {
      from.onLeave?.();
      from.el.classList.remove('is-active');
      to.el.classList.add('is-active');
    }
    document.body.style.setProperty('--mx-stage', to.stage);
    if (from !== to) {
      /* seed the inner scroll by travel direction — but only on a real
         entry: a retarget back to the still-displayed view must not yank
         the user's inner position */
      to.el.scrollTop = entryBottom ? to.el.scrollHeight - to.el.clientHeight : 0;
      to.onEnter?.();
    }
    displayedIndex = i;
  }

  /** The displayed view has fully landed — pin its hash. */
  function landed(i: number): void {
    opts.onViewLanded?.(views[i].id, i); /* observers first — the hash guard below is not theirs */
    if (OVERLAY_HASH.test(location.hash)) return; /* #/blog/… owns the URL */
    history.replaceState(null, '', '#' + views[i].id);
  }

  /* ------------------------------ transitions ----------------------------- */

  function swapInstant(i: number, entryBottom: boolean): void {
    killDomFx();
    opts.particles.killMorph();
    const from = views[displayedIndex];
    const to = views[i];
    /* a killed crossfade may have left inline opacity/visibility on the
       view roots — clear the deck-owned props so no panel re-enters blank */
    gsap.set([from.el, to.el], { clearProps: 'opacity,visibility' });
    restoreHero(to);
    swapDisplayed(i, entryBottom);
    to.playEntrance(); /* reduced motion → sections settle instant-visible */
    transitioning = false;
    landed(i);
  }

  /** Rare fallback when the particle canvas is unavailable. */
  function crossfade(i: number, entryBottom: boolean): void {
    killDomFx();
    const from = views[displayedIndex];
    const to = views[i];
    transitioning = true;
    const tl = gsap.timeline({
      onComplete() {
        transitioning = false;
      },
    });
    domFx = tl;
    tl.to(from.el, { autoAlpha: 0, duration: 0.15, ease: 'none' });
    tl.call(() => {
      gsap.set(from.el, { clearProps: 'opacity,visibility' });
      restoreHero(from);
      restoreHero(to);
      swapDisplayed(i, entryBottom);
      to.prepareEntrance();
    });
    tl.fromTo(
      to.el,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.2, ease: 'none', immediateRender: false, clearProps: 'opacity,visibility' },
    );
    tl.call(() => {
      to.playEntrance();
      landed(i);
    });
  }

  function startMorph(i: number, entryBottom: boolean): void {
    const from = views[displayedIndex];
    const to = views[i];
    const interrupted = opts.particles.morphActive();
    killDomFx();
    const outgoing = heroEls(from);
    gsap.killTweensOf(outgoing);

    const ok = opts.particles.morph({
      fromThemeId: from.themeId,
      toThemeId: to.themeId,
      fromHeadline: !interrupted && rectOnScreen(from.headline) ? from.headline : null,
      onSwap() {
        swapDisplayed(i, entryBottom);
        gsap.killTweensOf(to.headline);
        gsap.set(to.headline, { autoAlpha: 0 });
        to.prepareEntrance(); /* view's own choreography hides its pieces */
        return rectOnScreen(to.headline) ? to.headline : null;
      },
      onLand() {
        killDomFx();
        const tl = gsap.timeline();
        domFx = tl;
        tl.to(
          to.headline,
          { autoAlpha: 1, duration: opts.revealSeconds, ease: 'power1.inOut' },
          0,
        );
        tl.call(() => to.playEntrance(), undefined, 0);
        landed(i);
      },
      onComplete() {
        transitioning = false;
      },
    });

    if (!ok) {
      crossfade(i, entryBottom);
      return;
    }
    transitioning = true;

    if (interrupted) {
      /* the swarm keeps flying; the half-revealed DOM ducks out instantly */
      gsap.set(outgoing, { autoAlpha: 0 });
    } else {
      const tl = gsap.timeline();
      domFx = tl;
      tl.set(from.headline, { autoAlpha: 0 }, 0.02);
      if (from.rise?.length) {
        tl.to(
          from.rise,
          { autoAlpha: 0, y: -14, duration: 0.3, stagger: 0.02, ease: 'power1.in' },
          0,
        );
      }
    }
  }

  /* ------------------------------- controller ----------------------------- */

  /**
   * THE single entry point. The track callback, goTo and the keyboard all
   * funnel through here; it never morphs to the already-displayed view and
   * never lets two transitions fight.
   */
  function request(i: number, entry: 'top' | 'auto'): void {
    i = clampIdx(i, N);
    if (i === targetIndex) return;
    const entryBottom = entry === 'auto' && i < displayedIndex;
    targetIndex = i;
    root.style.setProperty('--mx-accent', views[i].accent);
    opts.onViewTargeted?.(views[i].id, i);
    if (opts.reduced()) {
      swapInstant(i, entryBottom);
      return;
    }
    if (i === displayedIndex && !transitioning) return;
    startMorph(i, entryBottom);
  }

  /* ------------------------------ navigation ------------------------------ */

  function killScrollTween(): void {
    if (scrollTween) {
      scrollTween.kill();
      scrollTween = null;
    }
  }

  /* a wheel or touch takes the wheel back from any programmatic travel */
  const onUserScroll = (): void => killScrollTween();
  window.addEventListener('wheel', onUserScroll, { passive: true });
  window.addEventListener('touchmove', onUserScroll, { passive: true });

  function goTo(i: number, entry: 'top' | 'auto' = 'top'): void {
    i = clampIdx(i, N);
    const y = slotY(i);
    if (opts.reduced()) {
      window.scrollTo(0, y);
      request(i, entry);
      return;
    }
    killScrollTween();
    const proxy = { y: window.scrollY };
    const dist = Math.abs(y - proxy.y);
    const duration = gsap.utils.clamp(0.4, 1.2, dist / 2600);
    scrollTween = gsap.to(proxy, {
      y,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => window.scrollTo(0, proxy.y),
      onComplete: () => {
        scrollTween = null;
      },
    });
    request(i, entry);
  }

  /* -------------------------------- keyboard ------------------------------ */

  function stepKeys(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (scrollLocked()) return; /* the blog overlay owns input while open */
    const t = e.target as Element | null;
    if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;

    if (e.key === 'Escape') {
      if (targetIndex !== 0) {
        e.preventDefault();
        goTo(0, 'top');
      }
      return;
    }

    const down = e.key === 'ArrowDown' || e.key === 'PageDown';
    const up = e.key === 'ArrowUp' || e.key === 'PageUp';
    if (!down && !up) return;

    const el = views[displayedIndex].el;
    const atTop = el.scrollTop <= 2;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const page = e.key === 'PageDown' || e.key === 'PageUp';
    const step = page ? el.clientHeight * 0.85 : 64;

    if (down) {
      if (atBottom) {
        if (targetIndex < N - 1) {
          e.preventDefault();
          goTo(targetIndex + 1, 'auto');
        }
      } else {
        e.preventDefault();
        el.scrollBy({ top: step, behavior: opts.reduced() ? 'auto' : 'smooth' });
      }
    } else {
      if (atTop) {
        if (targetIndex > 0) {
          e.preventDefault();
          goTo(targetIndex - 1, 'auto');
        }
      } else {
        e.preventDefault();
        el.scrollBy({ top: -step, behavior: opts.reduced() ? 'auto' : 'smooth' });
      }
    }
  }
  window.addEventListener('keydown', stepKeys);

  /* --------------------------------- boot --------------------------------- */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  /* the deck drives its own refresh (debounced resize in main.ts) so a
     mid-resize auto-refresh can never remap the track under our feet */
  ScrollTrigger.config({
    ignoreMobileResize: true,
    autoRefreshEvents: 'visibilitychange,DOMContentLoaded,load',
  });
  buildMaster();

  {
    const v = views[displayedIndex];
    v.el.classList.add('is-active');
    document.body.style.setProperty('--mx-stage', v.stage);
    root.style.setProperty('--mx-accent', v.accent);
    opts.onViewTargeted?.(v.id, displayedIndex);
    v.onEnter?.();
    if (!scrollLocked()) window.scrollTo(0, slotY(displayedIndex));
    landed(displayedIndex);
    if (!opts.skipInitialEntrance) {
      v.prepareEntrance();
      v.playEntrance();
    }
  }

  /* ------------------------------- lifecycle ------------------------------ */

  return {
    get displayedIndex() {
      return displayedIndex;
    },
    get targetIndex() {
      return targetIndex;
    },
    goTo,
    refresh() {
      refreshing = true;
      ScrollTrigger.refresh();
      /* keep the displayed view stable: re-pin the scrollbar on its slot */
      if (!scrollTween && !scrollLocked()) {
        window.scrollTo(0, slotY(targetIndex));
      }
      refreshing = false;
    },
    syncMotion() {
      buildMaster(); /* snap on/off follows the preference */
      if (!opts.reduced()) return;
      killScrollTween();
      /* mid-flight flip: settle instantly on the latest target */
      if (transitioning || displayedIndex !== targetIndex) {
        window.scrollTo(0, slotY(targetIndex));
        swapInstant(targetIndex, false);
      } else {
        killDomFx();
        restoreHero(views[displayedIndex]);
      }
    },
    destroy() {
      killScrollTween();
      killDomFx();
      window.removeEventListener('wheel', onUserScroll);
      window.removeEventListener('touchmove', onUserScroll);
      window.removeEventListener('keydown', stepKeys);
      master?.kill();
      master = null;
      track.remove();
    },
  };
}
