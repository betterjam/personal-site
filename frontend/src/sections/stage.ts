/**
 * STAGE — the Candy Apple dark band (mixtape 'stage' renderer; the
 * frontend section in the current tape). Condensed display headline,
 * spotlight cards — the lit card's title wears the chrome shimmer.
 *
 * Entrance (deck lifecycle): when the view lands, the kicker/summary
 * rise, the headline gets its one-time chrome sweep as the morph
 * reveals it (the deck owns the headline's fade — the sweep only rides
 * background-position), and the items rise staggered. The spotlight
 * (is-active) follows hover/click exactly as in the mockup; its
 * continuous shimmer only runs while the view is displayed (.is-live
 * via onEnter/onLeave). Reduced motion: everything visible
 * immediately, no sweep, shimmer disabled by CSS, spotlight still
 * follows hover/click.
 */
import '../styles/stage.css';
import { gsap } from 'gsap';
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

export const buildStage: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-sg');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);
  const inner = el('div', 'sg-inner');
  col.appendChild(inner);

  const kick = el('p', 'sg-kicker', section.kicker);
  const headline = el('h2', 'sg-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const sum = el('p', 'sg-summary', section.summary);
  const plink = pageLink(section.id);
  const list = el('div', 'sg-items');

  const cards: HTMLElement[] = [];
  function light(i: number): void {
    cards.forEach((c, j) => c.classList.toggle('is-active', j === i));
  }
  copyItems.forEach((it, i) => {
    const card = el('article', 'sg-item');
    card.appendChild(el('h3', 'sg-item-title', it.title));
    card.appendChild(el('p', 'sg-item-deck', it.deck));
    const meta = el('div', 'sg-meta');
    for (const t of it.tags ?? []) meta.appendChild(el('span', 'sg-tag', t));
    card.appendChild(meta);
    /* the spotlight follows the pointer (or a tap); first card starts lit */
    card.addEventListener('mouseenter', () => light(i));
    card.addEventListener('click', () => light(i));
    cards.push(card);
    list.appendChild(card);
  });
  light(0);

  inner.append(kick, headline, sum, plink, list);
  host.appendChild(wrap);

  /* ---------------------------- entrance -------------------------------- */

  const everything: HTMLElement[] = [kick, sum, plink, ...cards]; /* headline is the morph's */
  let tl: gsap.core.Timeline | null = null;
  let sweepTween: gsap.core.Tween | null = null;

  function killSweep(): void {
    if (sweepTween) {
      sweepTween.kill();
      sweepTween = null;
    }
    headline.classList.remove('is-sweep');
    gsap.set(headline, { clearProps: 'backgroundPosition' });
  }

  /** One-time chrome sweep across the settled headline glyphs. */
  function sweep(): void {
    if (ctx.reduced()) return;
    headline.classList.add('is-sweep');
    sweepTween = gsap.fromTo(
      headline,
      { backgroundPosition: '125% 0' },
      {
        backgroundPosition: '-125% 0',
        duration: 1.35,
        ease: 'power1.inOut',
        onComplete: killSweep,
      },
    );
  }

  function killEntrance(): void {
    if (tl) {
      tl.kill();
      tl = null;
    }
    killSweep();
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
      gsap.set([kick, sum, plink], { opacity: 0, y: 24 });
      gsap.set(cards, { opacity: 0, y: 30 });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        return;
      }
      tl = gsap.timeline();
      tl.to(kick, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', clearProps: 'opacity,transform' }, 0);
      /* the chrome sweep rides the headline as the morph reveals it */
      tl.call(sweep, undefined, 0.42);
      tl.to(
        [sum, plink],
        { opacity: 1, y: 0, duration: 0.55, stagger: 0.08, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.3,
      );
      /* items rise staggered */
      tl.to(
        cards,
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.1, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.45,
      );
    },
    onEnter() {
      /* the active card's shimmer may run — the view is on stage */
      wrap.classList.add('is-live');
    },
    onLeave() {
      /* pause the continuous shimmer — never run offstage */
      wrap.classList.remove('is-live');
    },
    destroy() {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      killEntrance();
    },
  };
};

export default buildStage;
