/**
 * STRIPS — the Seafoam Swiss channel list (mixtape 'strips' renderer;
 * serves whichever sections map to it — 'backend' in the current tape).
 * CH 01/02/03 rows, boring on purpose, precise where it counts.
 *
 * Entrance (deck lifecycle): when the view lands, the head rises, the
 * strips rise with a stagger and each little seafoam swatch wipes in
 * (scaleX from 0, transformOrigin left). The headline belongs to the
 * particle morph — the deck reveals it. Reduced motion: everything is
 * visible immediately — no tweens, ever.
 */
import '../styles/strips.css';
import { gsap } from 'gsap';
import { pad2 } from '../engine/themes';
import { inlineItems } from '../engine/data';
import { pageLink, type SectionBuilder } from './types';

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

export const buildStrips: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-st');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kick = el('p', 'st-kicker', section.kicker);
  const headline = el('h2', 'st-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const sum = el('p', 'st-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kick, headline, sum, plink);
  col.appendChild(head);

  const list = el('ol', 'st-list');
  const items: HTMLElement[] = [];
  const swatches: HTMLElement[] = [];
  copyItems.forEach((it, i) => {
    const li = el('li', 'st-item');
    const idx = el('span', 'st-idx', 'CH ' + pad2(i + 1));
    const swatch = el('i', 'st-swatch');
    swatch.setAttribute('aria-hidden', 'true');
    idx.appendChild(swatch);
    li.appendChild(idx);
    li.appendChild(el('h3', 'st-title', it.title));
    li.appendChild(el('p', 'st-deck', it.deck));
    const tags = el('p', 'st-tags');
    for (const t of it.tags ?? []) tags.appendChild(el('span', null, t));
    li.appendChild(tags);
    list.appendChild(li);
    items.push(li);
    swatches.push(swatch);
  });
  col.appendChild(list);
  host.appendChild(wrap);

  /* ---------------------------- entrance -------------------------------- */

  const headRise: HTMLElement[] = [kick, sum, plink]; /* headline is the morph's */
  const everything: HTMLElement[] = [...headRise, ...items, ...swatches];
  let tl: gsap.core.Timeline | null = null;

  function killEntrance(): void {
    if (tl) {
      tl.kill();
      tl = null;
    }
    gsap.killTweensOf(everything);
  }

  /** Settle instantly — reduced-motion flip or teardown safety. */
  function showInstant(): void {
    killEntrance();
    gsap.set(everything, { clearProps: 'opacity,visibility,transform' });
  }

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onMotionChange = (): void => {
    if (ctx.reduced()) showInstant();
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onMotionChange);
  }

  return {
    el: wrap,
    headline,
    prepareEntrance() {
      if (ctx.reduced()) return;
      killEntrance();
      gsap.set(headRise, { opacity: 0, y: 24 });
      gsap.set(items, { opacity: 0, y: 30 });
      gsap.set(swatches, { scaleX: 0, transformOrigin: 'left center' });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        return;
      }
      tl = gsap.timeline();
      tl.to(
        headRise,
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.09, ease: 'power2.out', clearProps: 'opacity,transform' },
        0,
      );
      /* the strips rise with a stagger... */
      tl.to(
        items,
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.11, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.28,
      );
      /* ...and each seafoam swatch wipes in on the same beat, a hair later */
      tl.to(
        swatches,
        { scaleX: 1, duration: 0.5, stagger: 0.11, ease: 'power3.out', clearProps: 'transform' },
        0.46,
      );
    },
    destroy() {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      killEntrance();
    },
  };
};

export default buildStrips;
