/**
 * PEDALS — every guitar item is a stompbox, ported from mockup 07.
 * Full pedal anatomy: finish cycling (surf/candy/burst gold), knobs cut
 * from the item's tags, LED + glow + stomp burst, IN/OUT jacks, the
 * footswitch cap, and luminance-picked silkscreen ink per finish.
 *
 * Entrance (deck lifecycle): the kicker/summary rise (the headline is
 * the particle morph's — the deck reveals it), the pedals drop onto
 * the board (y from -20, stagger, power3.out) and then the FIRST pedal
 * auto-stomps — LED on, deck opens — exactly once, EVER (revisits
 * replay the drop, not the stomp). Stomping works as in the mockup;
 * one LED at a time. Reduced motion: board visible instantly, first
 * pedal already singing.
 */
import '../styles/pedals.css';
import { gsap } from 'gsap';
import { kebab, lum } from '../engine/themes';
import { inlineItems } from '../engine/data';
import { pageLink, type SectionBuilder } from './types';

const FINISHES = ['surfPedal', 'candyPedal', 'burstGold'];

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

interface Pedal {
  btn: HTMLButtonElement;
  glow: HTMLElement;
  burst: HTMLElement;
  cap: HTMLElement;
  finish: string;
}

export const buildPedals: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-pd');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kicker = el('p', 'pd-kicker', section.kicker);
  const headline = el('h2', 'pd-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const summary = el('p', 'pd-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kicker, headline, summary, plink);
  col.appendChild(head);

  const theme = ctx.themes[themeId];
  const pal = theme.palette;
  const T: Record<string, number> = theme.motion?.tempo ?? {};
  const E: Record<string, string> = theme.motion?.eases ?? {};
  const stompDur = T.stomp ?? 0.18;
  const stompEase = E.stomp ?? 'power2.in';
  const panelDur = T.panel ?? 0.7;
  const panelEase = E.panel ?? 'power3.out';

  /* luminance-picked silkscreen ink: dark tolex text on light finishes,
     bone white on dark ones */
  function inkFor(token: string): string {
    return lum(pal[token]) > 0.34 ? 'var(--p-tolex)' : 'var(--p-bone-white)';
  }

  const board = el('div', 'pd-board');
  const deckPanel = el('div', 'pd-deckpanel');
  const deckTitle = el('h3', 'pd-deck-title');
  const deckText = el('p', 'pd-deck-text');
  const deckTags = el('ul', 'pd-deck-tags');
  deckPanel.append(deckTitle, deckText, deckTags);

  const pedals: Pedal[] = [];
  let activePedal: number | null = null;

  function openDeck(i: number): void {
    const it = copyItems[i];
    deckTitle.textContent = it.title;
    deckText.textContent = it.deck;
    deckTags.textContent = '';
    for (const t of it.tags ?? []) {
      const li = el('li', 'pd-chip', t);
      li.insertBefore(el('i', 'pd-chipjack'), li.firstChild);
      deckTags.appendChild(li);
    }
    deckPanel.style.setProperty('--pd-accent', 'var(--p-' + kebab(pedals[i].finish) + ')');
    deckPanel.classList.add('is-open');
  }

  function stomp(i: number, animate: boolean): void {
    const ped = pedals[i];
    gsap.killTweensOf(deckPanel);
    if (activePedal === i) {
      /* stomp again: LED off, deck closes */
      activePedal = null;
      ped.btn.setAttribute('aria-pressed', 'false');
      gsap.killTweensOf(ped.glow);
      if (ctx.reduced()) gsap.set(ped.glow, { opacity: 0 });
      else gsap.to(ped.glow, { opacity: 0, duration: 0.15, ease: 'none' });
      deckPanel.classList.remove('is-open');
      return;
    }
    if (activePedal != null) {
      /* one LED at a time */
      const prev = pedals[activePedal];
      prev.btn.setAttribute('aria-pressed', 'false');
      gsap.killTweensOf(prev.glow);
      if (ctx.reduced()) gsap.set(prev.glow, { opacity: 0 });
      else gsap.to(prev.glow, { opacity: 0, duration: 0.12, ease: 'none' });
    }
    activePedal = i;
    ped.btn.setAttribute('aria-pressed', 'true');
    gsap.killTweensOf(ped.glow);
    if (animate && !ctx.reduced()) {
      gsap.fromTo(
        ped.cap,
        { y: 0 },
        { y: 3, duration: stompDur, ease: stompEase, yoyo: true, repeat: 1, clearProps: 'transform' },
      );
      gsap.to(ped.glow, { opacity: 1, duration: 0.1, ease: 'none', delay: stompDur });
      gsap.fromTo(
        ped.burst,
        { scale: 0.4, opacity: 0.9 },
        { scale: 2, opacity: 0, duration: 0.45, ease: 'power2.out', delay: stompDur },
      );
      openDeck(i);
      gsap.fromTo(
        deckPanel,
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: panelDur, ease: panelEase, clearProps: 'opacity,transform' },
      );
    } else {
      gsap.set(ped.glow, { opacity: 1 });
      openDeck(i);
    }
  }

  copyItems.forEach((it, i) => {
    const finish = FINISHES[i % FINISHES.length];
    const btn = el('button', 'pd-pedal');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', it.title);
    const shadow = el('span', 'pd-shadow');
    const enc = el('span', 'pd-enc');
    enc.style.setProperty('--finish', 'var(--p-' + kebab(finish) + ')');
    enc.style.setProperty('--ink3', inkFor(finish));

    const ledZone = el('span', 'pd-ledzone');
    const led = el('span', 'pd-led');
    const glow = el('span', 'pd-glow');
    const burst = el('span', 'pd-burst');
    led.appendChild(glow);
    ledZone.appendChild(led);
    ledZone.appendChild(burst);

    const knobRow = el('span', 'pd-knobrow');
    for (const t of (it.tags ?? []).slice(0, 3)) {
      const unit = el('span', 'pd-kunit');
      const knob = el('span', 'pd-knob');
      knob.style.setProperty('--rot', Math.max(-60, Math.min(60, (t.length - 6) * 12)) + 'deg');
      unit.appendChild(knob);
      unit.appendChild(el('span', 'pd-klabel', ctx.abbr(t)));
      knobRow.appendChild(unit);
    }

    const jackOut = el('span', 'pd-jack pd-jack-out');
    jackOut.appendChild(el('i', 'pd-jacknut'));
    jackOut.appendChild(el('span', 'pd-jacktag', 'OUT'));
    const jackIn = el('span', 'pd-jack pd-jack-in');
    jackIn.appendChild(el('i', 'pd-jacknut'));
    jackIn.appendChild(el('span', 'pd-jacktag', 'IN'));

    const name = el('span', 'pd-name', it.title);
    const stompZone = el('span', 'pd-stomp');
    const cap = el('span', 'pd-cap');
    stompZone.appendChild(cap);

    enc.append(ledZone, knobRow, name, stompZone, jackOut, jackIn);
    btn.appendChild(shadow);
    btn.appendChild(enc);
    btn.addEventListener('click', () => stomp(i, true));
    board.appendChild(btn);
    pedals.push({ btn, glow, burst, cap, finish });
  });
  col.appendChild(board);
  col.appendChild(deckPanel);

  host.appendChild(wrap);

  /* ------------------------------ entrance ------------------------------- */

  const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const btns = pedals.map((p) => p.btn);
  const headRise: HTMLElement[] = [kicker, summary, plink]; /* headline is the morph's */
  let entranceTl: gsap.core.Timeline | null = null;
  /* the first pedal auto-stomps exactly once, ever */
  let autoStomped = false;

  function autoStomp(animate: boolean): void {
    if (autoStomped) return;
    autoStomped = true;
    /* someone may have clicked a pedal mid-drop — never fight the user */
    if (activePedal === null && pedals.length) stomp(0, animate);
  }

  function killEntrance(): void {
    if (entranceTl) {
      entranceTl.kill();
      entranceTl = null;
    }
    gsap.killTweensOf([...headRise, ...btns]);
  }

  function showInstant(): void {
    killEntrance();
    gsap.set([...headRise, ...btns], { clearProps: 'opacity,visibility,transform' });
    for (const b of btns) b.classList.remove('is-dropping');
  }

  const onMqChange = (): void => {
    if (!mqReduced.matches) return;
    showInstant();
    /* settle LEDs/bursts/caps instantly to their logical state */
    for (const [i, p] of pedals.entries()) {
      gsap.killTweensOf([p.glow, p.burst, p.cap]);
      gsap.set(p.glow, { opacity: i === activePedal ? 1 : 0 });
      gsap.set(p.burst, { opacity: 0 });
      gsap.set(p.cap, { clearProps: 'transform' });
    }
    gsap.killTweensOf(deckPanel);
    gsap.set(deckPanel, { clearProps: 'opacity,transform' });
    autoStomp(false);
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
      for (const b of btns) b.classList.add('is-dropping');
      gsap.set(btns, { y: -20, opacity: 0 });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        /* the mockup boots with the first pedal already on — keep that */
        autoStomp(false);
        return;
      }
      entranceTl = gsap
        .timeline()
        /* kicker and summary rise around the morph-revealed headline */
        .to(
          headRise,
          { opacity: 1, y: 0, duration: 0.6, stagger: 0.09, ease: 'power2.out', clearProps: 'opacity,transform' },
          0,
        )
        /* pedals drop onto the board */
        .to(
          btns,
          {
            y: 0,
            opacity: 1,
            duration: 0.6,
            ease: 'power3.out',
            stagger: 0.1,
            clearProps: 'opacity,transform',
          },
          0.12,
        )
        .call(() => {
          for (const b of btns) b.classList.remove('is-dropping');
          /* ... and the first finish arrives already singing */
          autoStomp(true);
        });
    },
    destroy() {
      killEntrance();
      if (typeof mqReduced.removeEventListener === 'function') {
        mqReduced.removeEventListener('change', onMqChange);
      }
      for (const p of pedals) gsap.killTweensOf([p.glow, p.burst, p.cap, p.btn]);
      gsap.killTweensOf(deckPanel);
    },
  };
};

export default buildPedals;
