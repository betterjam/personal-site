/**
 * ORBIT — Surf Green knobs around the tortoiseshell pick, ported from
 * mockup 07. Serves `distributed-systems` in the current tape (projects
 * moved to 'showcase'); the SVG defs are namespaced by the engraving
 * (the pad2 section index), so two instances never share gradient/clip
 * ids.
 *
 * Entrance (deck lifecycle): the kicker/summary rise (the headline is
 * the particle morph's — the deck reveals it), the pick fades/scales
 * in, the dashed ring draws itself (rotate + opacity), then the knobs
 * pop around the circle with a back.out(1.6) stagger and the detail
 * card rises last. Selecting a knob swaps the card (tweens killed on
 * re-select). Reduced motion: everything visible instantly,
 * interactions still work.
 */
import '../styles/orbit.css';
import { gsap } from 'gsap';
import { pad2 } from '../engine/themes';
import { inlineItems } from '../engine/data';
import { pageLink, type SectionBuilder } from './types';

const PICK_PATH =
  'M100 4C154 4 196 34 196 86C196 148 138 210 100 228C62 210 4 148 4 86C4 34 46 4 100 4Z';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** createElementNS + attributes (+ optional text) — no HTML strings. */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  text?: string,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

/** Tortoiseshell pick SVG; every def id carries the engraving namespace.
    Built node by node via createElementNS — no HTML strings. */
function pickSvg(engraving: string): SVGSVGElement {
  const svg = svgEl('svg', {
    class: 'orb-pick-svg',
    viewBox: '0 0 200 232',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const defs = svgEl('defs', {});
  const clip = svgEl('clipPath', { id: 'opk-clip-' + engraving });
  clip.appendChild(svgEl('path', { d: PICK_PATH }));
  defs.appendChild(clip);

  const base = svgEl('radialGradient', { id: 'opk-base-' + engraving, cx: '38%', cy: '28%', r: '95%' });
  base.appendChild(
    svgEl('stop', { offset: '0', style: 'stop-color:color-mix(in srgb, var(--p-tortoise) 60%, var(--p-brass))' }),
  );
  base.appendChild(svgEl('stop', { offset: '.55', style: 'stop-color:var(--p-tortoise)' }));
  base.appendChild(
    svgEl('stop', { offset: '1', style: 'stop-color:color-mix(in srgb, var(--p-tortoise) 60%, var(--p-ink))' }),
  );
  defs.appendChild(base);

  const blobGrad = svgEl('radialGradient', { id: 'opk-blob-' + engraving });
  blobGrad.appendChild(
    svgEl('stop', { offset: '0', style: 'stop-color:color-mix(in srgb, var(--p-tortoise) 40%, var(--p-ink))' }),
  );
  blobGrad.appendChild(
    svgEl('stop', {
      offset: '1',
      style: 'stop-color:color-mix(in srgb, var(--p-tortoise) 40%, var(--p-ink));stop-opacity:0',
    }),
  );
  defs.appendChild(blobGrad);
  svg.appendChild(defs);

  svg.appendChild(svgEl('path', { d: PICK_PATH, fill: 'url(#opk-base-' + engraving + ')' }));

  const g = svgEl('g', { 'clip-path': 'url(#opk-clip-' + engraving + ')' });
  const blobs: Array<[cx: string, cy: string, rx: string, ry: string, opacity: string, transform: string]> = [
    ['52', '60', '46', '30', '.8', 'rotate(-18 52 60)'],
    ['152', '54', '38', '24', '.65', 'rotate(14 152 54)'],
    ['120', '178', '44', '30', '.72', 'rotate(-8 120 178)'],
    ['40', '148', '30', '22', '.6', 'rotate(22 40 148)'],
  ];
  for (const [cx, cy, rx, ry, opacity, transform] of blobs) {
    g.appendChild(
      svgEl('ellipse', { cx, cy, rx, ry, fill: 'url(#opk-blob-' + engraving + ')', opacity, transform }),
    );
  }
  svg.appendChild(g);

  svg.appendChild(
    svgEl('path', {
      d: PICK_PATH,
      fill: 'none',
      stroke: 'color-mix(in srgb, var(--p-brass) 55%, var(--p-tortoise))',
      'stroke-width': '2.5',
      opacity: '.9',
    }),
  );
  svg.appendChild(svgEl('text', { class: 'orb-pick-txt', x: '100', y: '124', 'text-anchor': 'middle' }, engraving));
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const buildOrbit: SectionBuilder = (host, section, index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-orb');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kicker = el('p', 'orb-kicker', section.kicker);
  const headline = el('h2', 'orb-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const summary = el('p', 'orb-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kicker, headline, summary, plink);
  col.appendChild(head);

  const stage = el('div', 'orb-stage');
  const ring = el('div', 'orb-ring');
  stage.appendChild(ring);
  const pick = el('div', 'orb-pick');
  const pickArt = pickSvg(pad2(index + 1));
  pick.appendChild(pickArt);
  stage.appendChild(pick);

  const card = el('div', 'orb-card');
  const cardTitle = el('h3', 'orb-card-title');
  const cardDeck = el('p', 'orb-card-deck');
  const cardTags = el('ul', 'orb-tags');
  card.append(cardTitle, cardDeck, cardTags);

  const knobs: HTMLButtonElement[] = [];
  /* the pop wrapper: entrance scale lives here so GSAP never clobbers the
     knob button's positioning transform (rotate/translate/rotate chain) */
  const kpops: HTMLElement[] = [];
  let selected = -1;
  const step = 360 / Math.max(1, copyItems.length);

  function select(i: number, animate: boolean): void {
    if (selected === i) return;
    selected = i;
    knobs.forEach((k, j) => {
      k.classList.toggle('is-on', j === i);
      k.setAttribute('aria-pressed', j === i ? 'true' : 'false');
    });
    const it = copyItems[i];
    cardTitle.textContent = it.title;
    cardDeck.textContent = it.deck;
    cardTags.textContent = '';
    for (const t of it.tags ?? []) cardTags.appendChild(el('li', 'orb-tag', t));
    gsap.killTweensOf(card);
    if (animate && !ctx.reduced()) {
      gsap.fromTo(
        card,
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out', clearProps: 'opacity,transform' },
      );
    }
  }

  copyItems.forEach((it, i) => {
    const b = el('button', 'orb-knob');
    b.type = 'button';
    b.style.setProperty('--ang', -90 + i * step + 'deg');
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', it.title);
    const kpop = el('span', 'orb-kpop');
    kpop.appendChild(el('span', 'orb-disc'));
    const ab = ctx.abbr(it.title);
    kpop.appendChild(el('span', 'orb-klbl' + (ab.length > 6 ? ' orb-klbl--sm' : ''), ab));
    b.appendChild(kpop);
    b.addEventListener('click', () => select(i, true));
    stage.appendChild(b);
    knobs.push(b);
    kpops.push(kpop);
  });
  col.appendChild(stage);
  col.appendChild(card);
  /* initial selection swaps content only — the entrance owns the card's
     first appearance, so no tween may be in flight when it hides it */
  select(0, false);

  host.appendChild(wrap);

  /* ------------------------------ entrance ------------------------------- */

  const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let entranceTl: gsap.core.Timeline | null = null;

  const headRise: HTMLElement[] = [kicker, summary, plink]; /* headline is the morph's */
  const animated = (): Element[] => [...headRise, pickArt, ring, ...kpops, card];

  function killEntrance(): void {
    if (entranceTl) {
      entranceTl.kill();
      entranceTl = null;
    }
    gsap.killTweensOf(animated());
  }

  function showInstant(): void {
    killEntrance();
    gsap.set(animated(), { clearProps: 'opacity,visibility,transform' });
  }

  const onMqChange = (): void => {
    if (mqReduced.matches) showInstant();
  };
  if (typeof mqReduced.addEventListener === 'function') {
    mqReduced.addEventListener('change', onMqChange);
  }

  return {
    el: wrap,
    headline,
    prepareEntrance() {
      if (ctx.reduced()) return;
      killEntrance();
      gsap.set(headRise, { opacity: 0, y: 24 });
      gsap.set(pickArt, { opacity: 0, scale: 0.8, transformOrigin: '50% 50%' });
      gsap.set(ring, { opacity: 0, rotation: -80 });
      gsap.set(kpops, { opacity: 0, scale: 0.4, transformOrigin: '50% 50%' });
      gsap.set(card, { opacity: 0, y: 16 });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        return;
      }
      entranceTl = gsap
        .timeline({ defaults: { ease: 'power2.out' } })
        /* kicker and summary rise around the morph-revealed headline */
        .to(
          headRise,
          { opacity: 1, y: 0, duration: 0.6, stagger: 0.09, clearProps: 'opacity,transform' },
          0,
        )
        /* the pick surfaces first */
        .to(pickArt, { opacity: 1, scale: 1, duration: 0.7, clearProps: 'opacity,transform' }, 0)
        /* the dashed ring draws itself in — a spin under a fade */
        .to(ring, { opacity: 1, rotation: 0, duration: 0.9, clearProps: 'opacity,transform' }, 0.08)
        /* knobs pop around the circle */
        .to(
          kpops,
          {
            opacity: 1,
            scale: 1,
            duration: 0.55,
            ease: 'back.out(1.6)',
            stagger: 0.07,
            clearProps: 'opacity,transform',
          },
          0.3,
        )
        /* the selected knob's card lands last */
        .to(card, { opacity: 1, y: 0, duration: 0.5, clearProps: 'opacity,transform' }, '-=0.25');
    },
    destroy() {
      killEntrance();
      if (typeof mqReduced.removeEventListener === 'function') {
        mqReduced.removeEventListener('change', onMqChange);
      }
    },
  };
};

export default buildOrbit;
