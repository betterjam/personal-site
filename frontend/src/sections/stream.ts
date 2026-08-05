/**
 * STREAM — the Event Log replay, ported from mockup 07 (finish 06).
 *
 * The view renders the section as an append-only log projection: monotonic
 * offsets, stable fake timestamps (tsMs/fmtTs — never Date-derived, so the
 * log reads identically on every visit), bracketed tags and a blinking
 * write-head caret. Landing on the view IS the replay: the lines stream
 * in with the mockup's stagger every time the deck brings the view on
 * stage. The caret blink is CSS-driven and pauses while the view is off
 * stage. Reduced motion: everything visible immediately, caret static.
 */
import '../styles/stream.css';
import { gsap } from 'gsap';
import { CONTENT, inlineItems } from '../engine/data';
import { pad2 } from '../engine/themes';
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

/* ------------------------------------------------------------ log math ---
   Lifted from the mockup: monotonic offsets + stable fake timestamps.
   Five boot events (the profile fields) precede the topics, then every
   section and item claims the next offset in content.json order. */

const T_BASE = ((9 * 60 + 41) * 60 + 7) * 1000; /* 09:41:07.000 — stable, no Date.now */
const tsCache: number[] = [T_BASE];

function tsMs(offset: number): number {
  while (tsCache.length <= offset) {
    const i = tsCache.length;
    tsCache.push(tsCache[i - 1] + 90 + ((i * 137) % 210));
  }
  return tsCache[offset];
}

function fmtTs(offset: number): string {
  const ms = tsMs(offset);
  const msec = ms % 1000;
  const totalS = (ms - msec) / 1000;
  const s = totalS % 60;
  const totalM = (totalS - s) / 60;
  const m = totalM % 60;
  const h = ((totalM - m) / 60) % 24;
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + '.' + String(msec).padStart(3, '0');
}

interface SectionOffsets {
  section: number;
  items: number[];
}

function offsetsFor(sectionId: string): SectionOffsets {
  let seq = 5; /* five boot events (profile fields) precede the topics */
  for (const s of CONTENT.sections) {
    const meta: SectionOffsets = { section: seq, items: [] };
    seq += 1;
    for (let i = 0; i < s.items.length; i++) {
      meta.items.push(seq);
      seq += 1;
    }
    if (s.id === sectionId) return meta;
  }
  return { section: seq, items: [] };
}

/* ---------------------------------------------------------------- band --- */

export const buildStream: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const motion = ctx.themes[themeId].motion;
  const tempo = motion?.tempo ?? {};
  const eases = motion?.eases ?? {};
  const lineIn = tempo.lineIn ?? 0.35;
  const streamStagger = tempo.streamStagger ?? 0.06;
  const easeLineIn = eases.lineIn ?? 'power3.out';
  const blinkRaw = motion?.params?.caretBlinkSeconds;
  const blinkSeconds = typeof blinkRaw === 'number' ? blinkRaw : 1.1;

  const wrap = el('section', 'vw vw-ev is-offstage');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));
  wrap.style.setProperty('--ev-blink', blinkSeconds + 's');

  const col = el('div', 'mx-col');
  wrap.appendChild(col);
  const inner = el('div', 'ev-inner');
  col.appendChild(inner);

  const offs = offsetsFor(section.id);

  function metaSpan(offset: number, path?: string): HTMLElement {
    const m = el('span', 'ev-meta');
    m.appendChild(el('span', 'ev-off', String(offset).padStart(4, '0')));
    m.appendChild(el('span', 'ev-ts', fmtTs(offset)));
    if (path) m.appendChild(el('span', 'ev-path', path));
    return m;
  }

  /* the replay lines, in stream order — the headline stays out of the
     stream (it is the band's scroll target and particle anchor) */
  const lines: HTMLElement[] = [];
  function line<T extends HTMLElement>(node: T): T {
    lines.push(node);
    inner.appendChild(node);
    return node;
  }

  const topMeta = el('div', 'ev-ln');
  topMeta.appendChild(metaSpan(offs.section, 'topic/' + section.id));
  line(topMeta);
  line(el('p', 'ev-ln ev-kicker', section.kicker));

  const headline = el('h2', 'ev-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  inner.appendChild(headline);

  line(el('p', 'ev-ln ev-summary', section.summary));

  /* the full-page link replays as its own line, right after the summary */
  const plink = pageLink(section.id);
  plink.classList.add('ev-ln');
  line(plink);

  const entries = el('div', 'ev-entries');
  copyItems.forEach((it, i) => {
    const art = el('article', 'ev-entry ev-ln');
    const emeta = el('div', null);
    emeta.appendChild(metaSpan(offs.items[i] ?? offs.section + 1 + i, section.id + '/' + (i + 1)));
    art.appendChild(emeta);
    art.appendChild(el('h3', 'ev-title', it.title));
    art.appendChild(el('p', 'ev-deck', it.deck));
    const trow = el('div', 'ev-tags');
    if (it.date) trow.appendChild(el('span', 'ev-date', it.date));
    for (const t of it.tags ?? []) trow.appendChild(el('span', null, '[' + t + ']'));
    art.appendChild(trow);
    entries.appendChild(art);
    lines.push(art);
  });
  inner.appendChild(entries);

  line(
    el(
      'p',
      'ev-ln ev-tail',
      'end of stream · ' + copyItems.length + ' events replayed · esc returns to the overview',
    ),
  );

  const caret = el('span', 'ev-caret');
  caret.setAttribute('aria-hidden', 'true');
  caret.appendChild(el('i', 'ev-caret-i'));
  inner.appendChild(caret);

  host.appendChild(wrap);

  /* --------------------------------------------------------- choreography */

  let streamTl: gsap.core.Timeline | null = null;

  function killReplay(): void {
    if (streamTl) {
      streamTl.kill();
      streamTl = null;
    }
    gsap.killTweensOf(lines);
  }

  return {
    el: wrap,
    headline,
    prepareEntrance() {
      if (ctx.reduced()) return; /* all lines stay visible, caret static via CSS */
      killReplay();
      gsap.set(lines, { opacity: 0, y: 14 });
    },
    playEntrance() {
      killReplay();
      if (ctx.reduced()) {
        gsap.set(lines, { clearProps: 'opacity,transform' });
        return;
      }
      const tl = gsap.timeline({
        onComplete: () => {
          streamTl = null;
        },
      });
      lines.forEach((ln, i) => {
        tl.to(
          ln,
          { opacity: 1, y: 0, duration: lineIn, ease: easeLineIn, clearProps: 'opacity,transform' },
          i * streamStagger,
        );
      });
      streamTl = tl;
    },
    onEnter() {
      wrap.classList.remove('is-offstage'); /* caret blinks only on stage */
    },
    onLeave() {
      wrap.classList.add('is-offstage');
    },
    destroy() {
      killReplay();
    },
  };
};

export default buildStream;
