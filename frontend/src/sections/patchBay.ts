/**
 * PATCH BAY — the pedalboard jack wall, ported from mockup 07. Every
 * integration is a source jack; opening one draws a patch cable
 * (stroke-dashoffset tween, ported as-is) down to its destination jack
 * and reveals the deck below. The cable re-lays itself out on resize
 * while open. Jack buttons carry aria-expanded.
 *
 * Entrance (deck lifecycle): the kicker/summary rise (the headline is
 * the particle morph's — the deck reveals it), the wall rises, then
 * jacks pop in row by row — sources first, destinations after — with
 * back.out(1.6). Reduced motion: everything visible instantly, cable
 * snaps drawn.
 */
import '../styles/patchBay.css';
import { gsap } from 'gsap';
import { inlineItems } from '../engine/data';
import { pageLink, type SectionBuilder } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

export const buildPatchBay: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-pt');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kicker = el('p', 'pt-kicker', section.kicker);
  const headline = el('h2', 'pt-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const summary = el('p', 'pt-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kicker, headline, summary, plink);
  col.appendChild(head);

  const wall = el('div', 'pt-wall');
  const srcRow = el('div', 'pt-row pt-row-src');
  const dstRow = el('div', 'pt-row pt-row-dst');
  /* one column per item so src[i] always sits above dst[i] */
  const cols = 'repeat(' + Math.max(1, copyItems.length) + ', minmax(0, 1fr))';
  srcRow.style.gridTemplateColumns = cols;
  dstRow.style.gridTemplateColumns = cols;

  const srcBays: HTMLElement[] = [];
  const dstBays: HTMLElement[] = [];
  const srcBtns: HTMLButtonElement[] = [];
  const srcJacks: HTMLElement[] = [];
  const dstJacks: HTMLElement[] = [];

  copyItems.forEach((it, i) => {
    const bay = el('div', 'pt-bay');
    const btn = el('button', 'pt-jackbtn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', it.title);
    const jack = el('span', 'pt-jack');
    jack.appendChild(el('i', 'pt-ring'));
    btn.appendChild(jack);
    btn.appendChild(el('span', 'pt-tag', ctx.abbr(it.title)));
    btn.addEventListener('click', () => toggle(i));
    bay.appendChild(btn);
    srcRow.appendChild(bay);
    srcBays.push(bay);
    srcBtns.push(btn);
    srcJacks.push(jack);

    const dbay = el('div', 'pt-bay');
    const djack = el('span', 'pt-jack');
    djack.appendChild(el('i', 'pt-ring'));
    dbay.appendChild(djack);
    /* destination jack wears the item's last tag so the pair reads src -> dst */
    const tags = it.tags ?? [];
    dbay.appendChild(el('span', 'pt-tag', tags.length ? tags[tags.length - 1] : 'out'));
    dstRow.appendChild(dbay);
    dstBays.push(dbay);
    dstJacks.push(djack);
  });
  wall.appendChild(srcRow);
  wall.appendChild(dstRow);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pt-cables');
  svg.setAttribute('aria-hidden', 'true');
  const cablePaths = ['pt-cable-under', 'pt-cable-body', 'pt-cable-sheen'].map((cls) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('opacity', '0');
    svg.appendChild(p);
    return p;
  });
  const plugs = [0, 1].map(() => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'pt-plug');
    c.setAttribute('r', '5');
    c.setAttribute('opacity', '0');
    svg.appendChild(c);
    return c;
  });
  wall.appendChild(svg);
  col.appendChild(wall);

  const deck = el('div', 'pt-deck');
  const deckTitle = el('h3', 'pt-deck-title');
  const deckDeck = el('p', 'pt-deck-deck');
  const deckTags = el('ul', 'pt-deck-tags');
  deck.append(deckTitle, deckDeck, deckTags);
  col.appendChild(deck);

  /* ------------------------------ cable rig ------------------------------ */

  const motion = ctx.themes[themeId].motion;
  const T: Record<string, number> = motion?.tempo ?? {};
  const E: Record<string, string> = motion?.eases ?? {};
  const cableDur = T.cable ?? 0.6;
  const cableEase = E.cable ?? 'none';
  const panelDur = T.panel ?? 0.7;
  const panelEase = E.panel ?? 'power3.out';

  let openIdx: number | null = null;
  let cableTween: gsap.core.Tween | null = null;
  let cableLen = 0;

  function center(node: Element, ref: Element): [number, number] {
    const r = node.getBoundingClientRect();
    const w = ref.getBoundingClientRect();
    return [r.left + r.width / 2 - w.left, r.top + r.height / 2 - w.top];
  }
  function layoutCable(i: number): number {
    const a = center(srcJacks[i], wall);
    const b = center(dstJacks[i], wall);
    const sag = Math.max(40, (b[1] - a[1]) * 0.4);
    const d =
      'M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) +
      ' C ' + (a[0] - 26).toFixed(1) + ' ' + (a[1] + sag).toFixed(1) +
      ', ' + (b[0] + 26).toFixed(1) + ' ' + (b[1] - sag * 0.4).toFixed(1) +
      ', ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
    for (const p of cablePaths) p.setAttribute('d', d);
    plugs[0].setAttribute('cx', String(a[0]));
    plugs[0].setAttribute('cy', String(a[1]));
    plugs[1].setAttribute('cx', String(b[0]));
    plugs[1].setAttribute('cy', String(b[1]));
    cableLen = cablePaths[1].getTotalLength();
    return cableLen;
  }
  function setDash(off: number): void {
    for (const p of cablePaths) p.setAttribute('stroke-dashoffset', String(off));
  }
  function hideCable(): void {
    if (cableTween) {
      cableTween.kill();
      cableTween = null;
    }
    for (const p of cablePaths) p.setAttribute('opacity', '0');
    for (const p of plugs) p.setAttribute('opacity', '0');
  }
  function showCable(animate: boolean): void {
    const len = cableLen;
    cablePaths.forEach((p, ci) => {
      p.setAttribute('stroke-dasharray', String(len));
      p.setAttribute('opacity', ci === 2 ? '0.85' : '1');
    });
    plugs[0].setAttribute('opacity', '1');
    if (!animate) {
      setDash(0);
      plugs[1].setAttribute('opacity', '1');
      return;
    }
    setDash(len);
    const prox = { o: len };
    cableTween = gsap.to(prox, {
      o: 0,
      duration: cableDur,
      ease: cableEase,
      onUpdate: () => setDash(prox.o),
      onComplete: () => {
        plugs[1].setAttribute('opacity', '1');
        cableTween = null;
      },
    });
  }
  function syncBays(): void {
    srcBays.forEach((bay, i) => {
      const live = i === openIdx;
      bay.classList.toggle('is-live', live);
      dstBays[i].classList.toggle('is-live', live);
      srcBtns[i].setAttribute('aria-expanded', live ? 'true' : 'false');
    });
  }
  function toggle(i: number): void {
    gsap.killTweensOf(deck);
    if (openIdx === i) {
      openIdx = null;
      syncBays();
      hideCable();
      deck.classList.remove('is-open');
      return;
    }
    openIdx = i;
    syncBays();
    hideCable();
    const it = copyItems[i];
    deckTitle.textContent = it.title;
    deckDeck.textContent = it.deck;
    deckTags.textContent = '';
    for (const t of it.tags ?? []) {
      const li = el('li', 'pt-chip', t);
      li.insertBefore(el('i', 'pt-chipjack'), li.firstChild);
      deckTags.appendChild(li);
    }
    deck.classList.add('is-open');
    layoutCable(i);
    if (ctx.reduced()) {
      showCable(false);
    } else {
      showCable(true);
      gsap.fromTo(
        deck,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: panelDur, ease: panelEase, clearProps: 'opacity,transform' },
      );
    }
  }

  /* re-layout the cable on resize while an item is open */
  let rzT: number | null = null;
  const onResize = (): void => {
    if (rzT != null) window.clearTimeout(rzT);
    rzT = window.setTimeout(() => {
      rzT = null;
      if (openIdx != null) {
        layoutCable(openIdx);
        showCable(false);
      }
    }, 160);
  };
  window.addEventListener('resize', onResize);

  host.appendChild(wrap);

  /* ------------------------------ entrance ------------------------------- */

  const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let entranceTl: gsap.core.Timeline | null = null;

  const headRise: HTMLElement[] = [kicker, summary, plink]; /* headline is the morph's */
  const bays = (): Element[] => [...srcBays, ...dstBays];
  const animated = (): Element[] => [...headRise, wall, ...bays()];

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
    if (mqReduced.matches) {
      showInstant();
      if (openIdx != null) {
        if (cableTween) {
          cableTween.kill();
          cableTween = null;
        }
        gsap.killTweensOf(deck);
        gsap.set(deck, { clearProps: 'opacity,transform' });
        layoutCable(openIdx);
        showCable(false);
      }
    }
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
      gsap.set(wall, { opacity: 0, y: 26 });
      gsap.set(bays(), { opacity: 0, scale: 0.55, transformOrigin: '50% 50%' });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
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
        /* the wall itself rises */
        .to(wall, { opacity: 1, y: 0, duration: 0.55, ease: 'power2.out', clearProps: 'opacity,transform' }, 0.06)
        /* jacks pop in, row by row: sources first ... */
        .to(
          srcBays,
          {
            opacity: 1,
            scale: 1,
            duration: 0.5,
            ease: 'back.out(1.6)',
            stagger: 0.06,
            clearProps: 'opacity,transform',
          },
          0.24,
        )
        /* ... then the destinations answer */
        .to(
          dstBays,
          {
            opacity: 1,
            scale: 1,
            duration: 0.5,
            ease: 'back.out(1.6)',
            stagger: 0.06,
            clearProps: 'opacity,transform',
          },
          0.5,
        );
      /* the cable re-lays itself out once the wall has settled */
      if (openIdx != null) {
        entranceTl.call(
          () => {
            if (openIdx != null) {
              layoutCable(openIdx);
              showCable(false);
            }
          },
          undefined,
          1.1,
        );
      }
    },
    destroy() {
      killEntrance();
      if (cableTween) {
        cableTween.kill();
        cableTween = null;
      }
      if (rzT != null) window.clearTimeout(rzT);
      window.removeEventListener('resize', onResize);
      if (typeof mqReduced.removeEventListener === 'function') {
        mqReduced.removeEventListener('change', onMqChange);
      }
      gsap.killTweensOf(deck);
    },
  };
};

export default buildPatchBay;
