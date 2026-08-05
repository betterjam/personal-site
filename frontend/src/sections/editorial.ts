/**
 * EDITORIAL — the generic Three-Tone Sunburst chapter, ported from
 * mockup 07: burst masthead band + sunburst disc, serif lede with a
 * drop cap, dated entries with margin tabs.
 *
 * Entrance (deck lifecycle): the burst BLOOM — disc scale 0.62 -> 1,
 * saturation returning, like mockup 03's chapter openings — is now part
 * of the entrance timeline played when the view lands; the kicker rises
 * with it and the lede/entries follow with the standard stagger. The
 * headline belongs to the particle morph — the deck reveals it.
 *
 * blog.ts (the live blog view) imports the shell/entry/bloom builders
 * from here so both views share one Sunburst treatment — no shared-file
 * edits needed.
 */
import '../styles/editorial.css';
import { gsap } from 'gsap';
import { inlineItems, type ContentSection } from '../engine/data';
import type { SectionBuilder, SectionCtx } from './types';

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

/* ------------------------------------------------------------- shell ----
   The Sunburst band + body skeleton both editorial and blog render into. */

export interface EditorialShell {
  /** The band root (.vw.vw-ed) with the theme tokens applied. */
  wrap: HTMLElement;
  /** The dark burst band at the top of the chapter. */
  band: HTMLElement;
  /** The sunburst disc — the bloom's scrub target. */
  disc: HTMLElement;
  kicker: HTMLElement;
  headline: HTMLElement;
  /** The paper body below the band. */
  body: HTMLElement;
  /** The measured column inside the body. */
  bodyCol: HTMLElement;
  /** The summary paragraph wearing the drop cap. */
  lede: HTMLElement;
  /** The (initially empty) entries grid. */
  entries: HTMLElement;
}

export function buildEditorialShell(
  section: ContentSection,
  ctx: SectionCtx,
  extraClass?: string,
): EditorialShell {
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-ed' + (extraClass ? ' ' + extraClass : ''));
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const band = el('div', 'ed-band');
  const disc = el('div', 'ed-disc');
  disc.setAttribute('aria-hidden', 'true');
  band.appendChild(disc);
  const bandInner = el('div', 'ed-band-inner mx-col');
  const kicker = el('p', 'ed-kicker', section.kicker);
  const headline = el('h2', 'ed-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  bandInner.appendChild(kicker);
  bandInner.appendChild(headline);
  band.appendChild(bandInner);
  wrap.appendChild(band);

  const body = el('div', 'ed-body');
  const bodyCol = el('div', 'mx-col');
  body.appendChild(bodyCol);
  const lede = el('p', 'ed-lede', section.summary);
  bodyCol.appendChild(lede);
  const entries = el('div', 'ed-entries');
  bodyCol.appendChild(entries);
  wrap.appendChild(body);

  return { wrap, band, disc, kicker, headline, body, bodyCol, lede, entries };
}

/* ------------------------------------------------------------- entry ---- */

export interface EditorialEntrySpec {
  title: string;
  deck: string;
  date?: string;
  tags?: string[];
  /** When set, the title renders as a real link (the live blog). */
  href?: string;
}

export interface EditorialEntry {
  root: HTMLElement;
  /** Present when the spec carried an href. */
  titleLink: HTMLAnchorElement | null;
}

export function buildEditorialEntry(spec: EditorialEntrySpec): EditorialEntry {
  const root = el('article', 'ed-entry');
  const margin = el('p', 'ed-margin');
  if (spec.date) margin.appendChild(el('span', 'ed-date', spec.date));
  for (const t of spec.tags ?? []) margin.appendChild(el('span', null, t));
  root.appendChild(margin);

  const main = el('div', null);
  const title = el('h3', 'ed-title');
  let titleLink: HTMLAnchorElement | null = null;
  if (spec.href) {
    titleLink = el('a', null, spec.title);
    titleLink.href = spec.href;
    title.appendChild(titleLink);
  } else {
    title.textContent = spec.title;
  }
  main.appendChild(title);
  main.appendChild(el('p', 'ed-deck', spec.deck));
  root.appendChild(main);

  return { root, titleLink };
}

/* ------------------------------------------------------------- bloom ----
   THE BLOOM — the chapter opening tilts its sunburst into the light,
   now part of the entrance timeline played when the view lands: the disc
   scales 0.62 -> 1 while its saturation returns and the kicker rises.
   (The headline's reveal is the deck's — it is the particle morph's
   anchor.) Reduced motion: no bloom, the CSS-seated disc is simply there. */

export interface BloomTargets {
  band: HTMLElement;
  disc: HTMLElement;
  headline: HTMLElement;
  kicker: HTMLElement;
}

/** Seed the pre-entrance state (call from prepareEntrance, motion only). */
export function prepareBurstBloom(t: BloomTargets): void {
  gsap.set(t.disc, { scale: 0.62, filter: 'saturate(0.22) brightness(0.82)' });
  gsap.set(t.kicker, { autoAlpha: 0, y: 14 });
}

/** The bloom leg of an entrance timeline (position it at 0). */
export function addBurstBloom(ctx: SectionCtx, t: BloomTargets, tl: gsap.core.Timeline): void {
  const motion = ctx.themes[ctx.mix.theme].motion;
  const easeBloom = motion?.eases?.bloom ?? 'power2.out';
  const easeReveal = motion?.eases?.reveal ?? 'power2.out';
  tl.to(
    t.disc,
    { scale: 1, filter: 'saturate(1) brightness(1)', duration: 0.9, ease: easeBloom, clearProps: 'transform,filter' },
    0,
  );
  tl.to(
    t.kicker,
    { autoAlpha: 1, y: 0, duration: 0.45, ease: easeReveal, clearProps: 'opacity,visibility,transform' },
    0.1,
  );
}

/** Settle the bloom targets instantly (reduced flip / teardown). */
export function settleBurstBloom(t: BloomTargets): void {
  gsap.killTweensOf([t.disc, t.kicker]);
  gsap.set([t.disc, t.kicker], { clearProps: 'opacity,visibility,transform,filter' });
}

/* -------------------------------------------------------------- band ---- */

export const buildEditorial: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const shell = buildEditorialShell(section, ctx);
  const entryEls: HTMLElement[] = [];
  for (const it of copyItems) {
    const entry = buildEditorialEntry({
      title: it.title,
      deck: it.deck,
      date: it.date,
      tags: it.tags,
    });
    shell.entries.appendChild(entry.root);
    entryEls.push(entry.root);
  }
  host.appendChild(shell.wrap);

  /* ------------------------------ entrance ------------------------------ */

  const risers: HTMLElement[] = [shell.lede, ...entryEls];
  let entranceTl: gsap.core.Timeline | null = null;

  function killEntrance(): void {
    if (entranceTl) {
      entranceTl.kill();
      entranceTl = null;
    }
    gsap.killTweensOf(risers);
  }

  function showInstant(): void {
    killEntrance();
    settleBurstBloom(shell);
    gsap.set(risers, { clearProps: 'opacity,visibility,transform' });
  }

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onMotionChange = (): void => {
    if (ctx.reduced()) showInstant();
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onMotionChange);
  }

  return {
    el: shell.wrap,
    headline: shell.headline,
    prepareEntrance() {
      if (ctx.reduced()) return;
      killEntrance();
      prepareBurstBloom(shell);
      gsap.set(risers, { opacity: 0, y: 24 });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        return;
      }
      entranceTl = gsap.timeline();
      addBurstBloom(ctx, shell, entranceTl);
      entranceTl.to(
        risers,
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.15,
      );
    },
    destroy() {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      killEntrance();
      settleBurstBloom(shell);
    },
  };
};

export default buildEditorial;
