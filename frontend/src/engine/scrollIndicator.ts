/**
 * SCROLL INDICATOR — a floating capsule fixed at the right edge of the
 * deck: one entry per view (hub + sections, deck order) as small dots on
 * a hairline, the active entry stretched into a pill tinted by the root
 * --mx-accent main.ts already re-tints per section. Above and below the
 * capsule, tiny mono hints announce where a scroll goes: up-chevron +
 * previous view, down-chevron + next view (hidden at the ends).
 *
 * Sync comes from the deck's targeting callback — the exact call sites
 * that drive markNavActive — so during a rapid multi-target morph the
 * indicator tracks the LATEST target, and hash deep-link boots land
 * already in agreement with the rail.
 *
 * No hardcoded palette hex: the chip translucency rides var(--mx-stage)
 * (the body token), the pill rides var(--mx-accent), and the neutral ink
 * is computed here per active view from lum(view.stage) and pushed as
 * --si-ink on the capsule root.
 */
import { gsap } from 'gsap';
import { lum } from './themes';
import '../styles/scrollIndicator.css';

export interface ScrollIndicatorView {
  id: string;
  /** Human label — aria-label, title tooltip and the prev/next hints. */
  label: string;
  /** Hex stage behind this view — decides the neutral ink. */
  stage: string;
}

export interface ScrollIndicatorOpts {
  views: ScrollIndicatorView[];
  reduced: () => boolean;
  /** Entry clicked — route through the same goTo path as the rail. */
  onSelect: (id: string, index: number) => void;
}

export interface ScrollIndicator {
  /** The <nav> root — a body-level fixed element. */
  readonly el: HTMLElement;
  /** A view became the navigation target (same call sites as the rail). */
  setActive(id: string): void;
  /** Fade in once the intro completes (instant under reduced motion). */
  reveal(): void;
  destroy(): void;
}

/** Stage luminance where white ink stops beating black ink (WCAG). */
const INK_FLIP = 0.18;

interface Hint {
  root: HTMLDivElement;
  lbl: HTMLSpanElement;
}

export function initScrollIndicator(opts: ScrollIndicatorOpts): ScrollIndicator {
  const { views } = opts;
  const N = views.length;

  const nav = document.createElement('nav');
  nav.className = 'mx-si';
  nav.setAttribute('aria-label', 'Section progress');

  /* prev/next hints are a decorative echo of the buttons — hidden from
     AT wholesale, which also covers the chevron glyphs inside */
  function buildHint(dir: 'up' | 'down'): Hint {
    const root = document.createElement('div');
    root.className = 'mx-si-hint mx-si-hint-' + dir;
    root.setAttribute('aria-hidden', 'true');
    const chev = document.createElement('span');
    chev.className = 'mx-si-chev mx-si-chev-' + dir;
    const lbl = document.createElement('span');
    lbl.className = 'mx-si-hint-lbl';
    root.appendChild(chev);
    root.appendChild(lbl);
    return { root, lbl };
  }

  const hintUp = buildHint('up');
  const hintDown = buildHint('down');

  const capsule = document.createElement('div');
  capsule.className = 'mx-si-capsule';

  const buttons: HTMLButtonElement[] = views.map((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mx-si-dot';
    b.setAttribute('aria-label', v.label);
    b.title = v.label;
    b.addEventListener('click', () => opts.onSelect(v.id, i));
    capsule.appendChild(b);
    return b;
  });

  nav.appendChild(hintUp.root);
  nav.appendChild(capsule);
  nav.appendChild(hintDown.root);
  document.body.appendChild(nav);

  /* blank until the deck announces its boot target */
  gsap.set([hintUp.root, hintDown.root], { autoAlpha: 0 });

  let activeIdx = -1;
  let revealed = false;

  function setHint(h: Hint, text: string | null, dy: number, instant: boolean): void {
    gsap.killTweensOf(h.root);
    if (text == null) {
      gsap.set(h.root, { autoAlpha: 0, y: 0 }); /* end of the deck — hide */
      return;
    }
    h.lbl.textContent = text;
    if (instant || opts.reduced()) {
      gsap.set(h.root, { autoAlpha: 1, y: 0 });
      return;
    }
    gsap.fromTo(
      h.root,
      { autoAlpha: 0, y: dy },
      { autoAlpha: 1, y: 0, duration: 0.25, ease: 'power2.out' },
    );
  }

  function setActive(id: string): void {
    const i = views.findIndex((v) => v.id === id);
    if (i < 0 || i === activeIdx) return;
    /* first activation (boot — plain or hash deep-link) has nothing to
       slide from: swap labels instantly, no tweens. After that, labels
       slide with the travel direction; a retarget mid-morph just re-runs
       this with the newest index — killTweensOf keeps it clean */
    const boot = activeIdx < 0;
    const dy = !boot && i < activeIdx ? -5 : 5;
    activeIdx = i;

    /* neutral ink for THIS stage: dark stage -> light ink, and back */
    nav.style.setProperty('--si-ink', lum(views[i].stage) > INK_FLIP ? '#000' : '#fff');

    buttons.forEach((b, j) => {
      const on = j === i;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });

    setHint(hintUp, i > 0 ? views[i - 1].label : null, dy, boot);
    setHint(hintDown, i < N - 1 ? views[i + 1].label : null, dy, boot);
  }

  function reveal(): void {
    gsap.killTweensOf(nav);
    if (revealed || opts.reduced()) {
      /* second call (or reduced motion): settle instantly */
      revealed = true;
      gsap.set(nav, { autoAlpha: 1, x: 0 });
      return;
    }
    revealed = true;
    gsap.fromTo(
      nav,
      { autoAlpha: 0, x: 12 },
      { autoAlpha: 1, x: 0, duration: 0.6, ease: 'power2.out' },
    );
  }

  return {
    el: nav,
    setActive,
    reveal,
    destroy() {
      gsap.killTweensOf([nav, hintUp.root, hintDown.root]);
      nav.remove();
    },
  };
}
