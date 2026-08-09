/**
 * MANUAL — the amp service manual (mixtape 'manual' renderer; serves
 * whichever sections map to it — 'distributed-systems' in the current
 * tape). "Everything fails, plan for it" is what a tube-amp service
 * manual IS: schematics on aged paper whose whole purpose is the failure
 * that has not happened yet.
 *
 * Each item is a FIGURE PLATE: an ink schematic that animates the item's
 * failure drill, with the copy beside it as the manual's text. Three
 * archetype figures cycle by item index:
 *   0 — the saga chain: stages commit, S4 fails, compensation walks BACK
 *   1 — the valve: input runs hot, inlet narrows (honest 429), output
 *       stays bounded — tubes are valves, soft clipping is grace
 *   2 — test points: a probe sweeps TP1..TP3, one reading is out of
 *       range and gets circled — the 3 a.m. map
 *
 * Lifecycle: drills loop only while the view is on stage (onEnter/
 * onLeave). Reduced motion: no loops ever — each figure settles on its
 * final storytelling frame, which reads as a printed diagram.
 */
import '../styles/manual.css';
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

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  cls?: string,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (cls) n.setAttribute('class', cls);
  return n;
}

function text(x: number, y: number, str: string, cls: string): SVGTextElement {
  const t = svg('text', { x: String(x), y: String(y) }, cls);
  t.textContent = str;
  return t;
}

/** Prime a path for draw-on (dashoffset animation). */
function primeDraw(paths: SVGGeometryElement[]): void {
  for (const p of paths) {
    const len = p.getTotalLength();
    p.style.strokeDasharray = String(len);
    p.style.strokeDashoffset = String(len);
  }
}

interface Figure {
  root: SVGSVGElement;
  caption: string;
  /** Restart the drill loop (kills the previous one). */
  start(): void;
  stop(): void;
  /** The printed final frame — reduced motion and teardown. */
  settle(): void;
}

/* ------------------------------------------------ FIG archetype: saga */

function figSaga(): Figure {
  const root = svg('svg', { viewBox: '0 0 340 150', 'aria-hidden': 'true' });
  const xs = [12, 96, 180, 264];
  const base: SVGGeometryElement[] = [];
  const ticks: SVGElement[] = [];
  xs.forEach((x, i) => {
    const r = svg('rect', { x: String(x), y: '52', width: '64', height: '32', rx: '3' }, 'mn-lna');
    root.appendChild(r);
    base.push(r);
    root.appendChild(text(x + 32, 72, 'S' + (i + 1), 'mn-txt mn-mid'));
    if (i < xs.length - 1) {
      const a = svg('path', { d: `M ${x + 64} 68 H ${x + 84}` }, 'mn-lna');
      root.appendChild(a);
      base.push(a);
    }
  });
  /* commit ticks above S1..S3 */
  for (let i = 0; i < 3; i += 1) {
    const t = svg('path', { d: `M ${xs[i] + 24} 40 l 6 6 l 10 -12` }, 'mn-ok mn-drill');
    root.appendChild(t);
    ticks.push(t);
  }
  /* the failure: X over S4 */
  const fail = svg('g', {}, 'mn-drill');
  fail.appendChild(svg('path', { d: `M ${xs[3] + 14} 56 l 36 24` }, 'mn-fault'));
  fail.appendChild(svg('path', { d: `M ${xs[3] + 50} 56 l -36 24` }, 'mn-fault'));
  root.appendChild(fail);
  /* compensation arcs walking back 4→3→2→1, with brass undo rings */
  const arcs: SVGGeometryElement[] = [];
  const rings: SVGElement[] = [];
  for (let i = 2; i >= 0; i -= 1) {
    const from = xs[i + 1] + 20;
    const to = xs[i] + 44;
    const a = svg('path', { d: `M ${from} 96 C ${from - 20} 118, ${to + 20} 118, ${to} 98 l -3 -6 m 3 6 l 7 -2` }, 'mn-brass mn-dash mn-drill');
    root.appendChild(a);
    arcs.push(a);
    const ring = svg('circle', { cx: String(xs[i] + 32), cy: '68', r: '24' }, 'mn-brass mn-drill');
    ring.setAttribute('fill', 'none');
    root.appendChild(ring);
    rings.push(ring);
  }
  root.appendChild(text(12, 142, 'compensation runs in reverse order', 'mn-txt'));

  let tl: gsap.core.Timeline | null = null;
  const drill = [...ticks, fail, ...arcs, ...rings];
  function stop(): void {
    if (tl) tl.kill();
    tl = null;
    gsap.killTweensOf([...base, ...drill]);
  }
  return {
    root,
    caption: 'FIG. 1 — the rehearsed apology',
    start() {
      stop();
      primeDraw(base);
      gsap.set(drill, { opacity: 0 });
      tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6 });
      tl.to(base, { strokeDashoffset: 0, duration: 0.8, stagger: 0.06, ease: 'power1.inOut' }, 0);
      tl.to(ticks, { opacity: 1, duration: 0.25, stagger: 0.35 }, 0.9);
      tl.to(fail, { opacity: 1, duration: 0.12, repeat: 3, yoyo: true }, 2.2);
      tl.set(fail, { opacity: 1 }, 2.8);
      arcs.forEach((a, i) => {
        tl!.to(a, { opacity: 1, duration: 0.3 }, 3.0 + i * 0.55);
        tl!.to(rings[i], { opacity: 1, duration: 0.25 }, 3.25 + i * 0.55);
      });
      tl.to(drill, { opacity: 0, duration: 0.5 }, 6.4);
      tl.set(base, { strokeDashoffset: (_i: number, t: unknown) => (t as SVGGeometryElement).getTotalLength() }, 7.0);
    },
    stop,
    settle() {
      stop();
      for (const p of base) p.style.strokeDasharray = '';
      gsap.set(base, { clearProps: 'strokeDashoffset' });
      gsap.set(drill, { opacity: 1 });
    },
  };
}

/* ----------------------------------------------- FIG archetype: valve */

function figValve(): Figure {
  const root = svg('svg', { viewBox: '0 0 340 150', 'aria-hidden': 'true' });
  const base: SVGGeometryElement[] = [];
  /* input wave (grows hot), valve triode, bounded output wave */
  const inWave = svg('g');
  const inPath = svg('path', { d: 'M 10 72 q 12 -22 24 0 t 24 0 t 24 0 t 24 0' }, 'mn-lna');
  inWave.appendChild(inPath);
  root.appendChild(inWave);
  base.push(inPath);
  const valve = svg('g');
  const bulb = svg('circle', { cx: '170', cy: '72', r: '24', fill: 'none' }, 'mn-lna');
  const plate = svg('path', { d: 'M 158 62 H 182' }, 'mn-lna');
  const cathode = svg('path', { d: 'M 160 84 H 180 M 170 84 V 96' }, 'mn-lna');
  const grid = svg('path', { d: 'M 156 72 h 4 m 4 0 h 4 m 4 0 h 4 m 4 0 h 4 m 4 0 h 4', 'stroke-linecap': 'round' }, 'mn-lna');
  valve.append(bulb, plate, cathode, grid);
  root.appendChild(valve);
  base.push(bulb, plate, cathode, grid);
  const outPath = svg('path', { d: 'M 206 72 q 12 -16 24 0 t 24 0 t 24 0 t 24 0' }, 'mn-ok-line');
  root.appendChild(outPath);
  base.push(outPath);
  /* queue meter + honest 429 */
  const meterBox = svg('rect', { x: '120', y: '20', width: '10', height: '34', rx: '2' }, 'mn-lna');
  root.appendChild(meterBox);
  base.push(meterBox);
  const meterFill = svg('rect', { x: '122', y: '52', width: '6', height: '0' }, 'mn-brass-fill');
  root.appendChild(meterFill);
  const stamp = svg('g', {}, 'mn-drill');
  const stampBox = svg('rect', { x: '76', y: '24', width: '34', height: '18', rx: '2', fill: 'none' }, 'mn-fault');
  stamp.appendChild(stampBox);
  stamp.appendChild(text(93, 37, '429', 'mn-txt mn-mid mn-fault-txt'));
  root.appendChild(stamp);
  root.appendChild(text(12, 142, 'the output never clips — the inlet says no first', 'mn-txt'));

  let tl: gsap.core.Timeline | null = null;
  function stop(): void {
    if (tl) tl.kill();
    tl = null;
    gsap.killTweensOf([...base, inWave, meterFill, stamp]);
  }
  return {
    root,
    caption: 'FIG. 2 — the valve holds the line',
    start() {
      stop();
      primeDraw(base);
      gsap.set(stamp, { opacity: 0 });
      gsap.set(meterFill, { attr: { y: 52, height: 0 } });
      gsap.set(inWave, { scaleY: 1, transformOrigin: '50% 50%' });
      tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });
      tl.to(base, { strokeDashoffset: 0, duration: 0.9, stagger: 0.05, ease: 'power1.inOut' }, 0);
      /* load rises: the input runs hot, the queue fills */
      tl.to(inWave, { scaleY: 1.8, duration: 1.6, ease: 'power1.in' }, 1.2);
      tl.to(meterFill, { attr: { y: 22, height: 30 }, duration: 1.6, ease: 'power1.in' }, 1.2);
      /* the honest refusal — and the output wave never moved */
      tl.to(stamp, { opacity: 1, duration: 0.2, repeat: 2, yoyo: true }, 2.9);
      tl.set(stamp, { opacity: 1 }, 3.5);
      /* drain */
      tl.to(inWave, { scaleY: 1, duration: 1.2, ease: 'power1.out' }, 4.4);
      tl.to(meterFill, { attr: { y: 52, height: 0 }, duration: 1.2, ease: 'power1.out' }, 4.4);
      tl.to(stamp, { opacity: 0, duration: 0.4 }, 4.8);
    },
    stop,
    settle() {
      stop();
      for (const p of base) p.style.strokeDasharray = '';
      gsap.set(base, { clearProps: 'strokeDashoffset' });
      gsap.set(inWave, { scaleY: 1.8, transformOrigin: '50% 50%' });
      gsap.set(meterFill, { attr: { y: 22, height: 30 } });
      gsap.set(stamp, { opacity: 1 });
    },
  };
}

/* ----------------------------------------- FIG archetype: test points */

function figProbe(): Figure {
  const root = svg('svg', { viewBox: '0 0 340 150', 'aria-hidden': 'true' });
  const base: SVGGeometryElement[] = [];
  const line = svg('path', { d: 'M 12 90 H 328' }, 'mn-lna');
  root.appendChild(line);
  base.push(line);
  /* three stages on the line: rect, amp triangle, rect */
  const s1 = svg('rect', { x: '48', y: '74', width: '34', height: '32', rx: '3' }, 'mn-lna mn-paper');
  const s2 = svg('path', { d: 'M 154 70 v 40 l 34 -20 Z' }, 'mn-lna mn-paper');
  const s3 = svg('rect', { x: '256', y: '74', width: '34', height: '32', rx: '3' }, 'mn-lna mn-paper');
  root.append(s1, s2, s3);
  base.push(s1, s2, s3);
  /* test point flags with printed readings */
  const tps = [
    { x: 110, label: 'TP1', ok: '0.9v' },
    { x: 214, label: 'TP2', ok: '1.2v' },
    { x: 310, label: 'TP3', ok: '4.7v' },
  ];
  const readings: SVGTextElement[] = [];
  tps.forEach((tp) => {
    const drop = svg('path', { d: `M ${tp.x} 90 V 48` }, 'mn-lna mn-dash');
    root.appendChild(drop);
    base.push(drop);
    root.appendChild(text(tp.x, 40, tp.label, 'mn-txt mn-mid'));
    const val = text(tp.x, 28, tp.ok, 'mn-txt mn-mid mn-drill');
    root.appendChild(val);
    readings.push(val);
  });
  /* the probe, the bad reading, the map */
  const probe = svg('circle', { cx: '12', cy: '90', r: '5' }, 'mn-brass-fill mn-drill');
  root.appendChild(probe);
  const ring = svg('ellipse', { cx: '214', cy: '32', rx: '26', ry: '15', fill: 'none' }, 'mn-brass mn-drill');
  root.appendChild(ring);
  const here = text(258, 32, '→ here', 'mn-txt mn-fault-txt mn-drill');
  root.appendChild(here);
  root.appendChild(text(12, 142, 'expected readings are printed on the map', 'mn-txt'));

  let tl: gsap.core.Timeline | null = null;
  const drill = [probe, ring, here, ...readings];
  function stop(): void {
    if (tl) tl.kill();
    tl = null;
    gsap.killTweensOf([...base, ...drill]);
  }
  return {
    root,
    caption: 'FIG. 3 — the 3 a.m. map',
    start() {
      stop();
      primeDraw(base);
      gsap.set(drill, { opacity: 0 });
      readings[1].textContent = '1.2v';
      readings[1].classList.remove('mn-fault-txt');
      tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6 });
      tl.to(base, { strokeDashoffset: 0, duration: 0.9, stagger: 0.04, ease: 'power1.inOut' }, 0);
      tl.to(probe, { opacity: 1, duration: 0.2 }, 1.0);
      tl.to(probe, { attr: { cx: 310 }, duration: 2.2, ease: 'none' }, 1.2);
      tps.forEach((_, i) => {
        tl!.to(readings[i], { opacity: 1, duration: 0.2 }, 1.2 + 2.2 * ((tps[i].x - 12) / 298));
      });
      /* TP2 is out of range: the reading flips, the map circles it */
      tl.add(() => {
        readings[1].textContent = '5.8v';
        readings[1].classList.add('mn-fault-txt');
      }, 3.7);
      tl.to(ring, { opacity: 1, duration: 0.25 }, 3.8);
      tl.to(here, { opacity: 1, duration: 0.25 }, 4.0);
      tl.to(drill, { opacity: 0, duration: 0.5 }, 6.2);
      tl.add(() => {
        readings[1].textContent = '1.2v';
        readings[1].classList.remove('mn-fault-txt');
        gsap.set(probe, { attr: { cx: 12 } });
      }, 6.8);
    },
    stop,
    settle() {
      stop();
      for (const p of base) p.style.strokeDasharray = '';
      gsap.set(base, { clearProps: 'strokeDashoffset' });
      readings[1].textContent = '5.8v';
      readings[1].classList.add('mn-fault-txt');
      gsap.set(drill, { opacity: 1 });
      gsap.set(probe, { attr: { cx: 214 } });
    },
  };
}

const ARCHETYPES = [figSaga, figValve, figProbe];

/* ---------------------------------------------------------- builder */

export const buildManual: SectionBuilder = (host, section, _index, ctx) => {
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-mn');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kick = el('p', 'mn-stamp', section.kicker);
  const headline = el('h2', 'mn-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const sum = el('p', 'mn-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kick, headline, sum, plink);
  col.appendChild(head);

  const plates: HTMLElement[] = [];
  const figures: Figure[] = [];
  const list = el('ol', 'mn-plates');
  copyItems.forEach((it, i) => {
    const li = el('li', 'mn-plate');
    const figure = ARCHETYPES[i % ARCHETYPES.length]();
    figures.push(figure);
    const figCol = el('div', 'mn-figcol');
    figCol.appendChild(figure.root);
    figCol.appendChild(el('p', 'mn-caption', figure.caption));
    li.appendChild(figCol);
    const copy = el('div', 'mn-copy');
    copy.appendChild(el('h3', 'mn-title', it.title));
    copy.appendChild(el('p', 'mn-deck', it.deck));
    const parts = el('p', 'mn-parts');
    parts.appendChild(el('span', 'mn-parts-label', 'parts list'));
    for (const t of it.tags ?? []) parts.appendChild(el('span', 'mn-part', t));
    copy.appendChild(parts);
    li.appendChild(copy);
    list.appendChild(li);
    plates.push(li);
  });
  col.appendChild(list);
  host.appendChild(wrap);

  /* ---------------------------- lifecycle ------------------------------ */

  const headRise: HTMLElement[] = [kick, sum, plink];
  let tl: gsap.core.Timeline | null = null;
  let onStage = false;

  function killEntrance(): void {
    if (tl) {
      tl.kill();
      tl = null;
    }
    gsap.killTweensOf([...headRise, ...plates]);
  }

  function stopFigures(): void {
    for (const f of figures) f.stop();
  }

  function settleFigures(): void {
    for (const f of figures) f.settle();
  }

  function startFigures(): void {
    if (ctx.reduced()) {
      settleFigures();
      return;
    }
    for (const f of figures) f.start();
  }

  function showInstant(): void {
    killEntrance();
    gsap.set([...headRise, ...plates], { clearProps: 'opacity,visibility,transform' });
    settleFigures();
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
      stopFigures();
      if (ctx.reduced()) return;
      killEntrance();
      gsap.set(headRise, { opacity: 0, y: 24 });
      gsap.set(plates, { opacity: 0, y: 34 });
    },
    playEntrance() {
      killEntrance();
      onStage = true;
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
      tl.to(
        plates,
        { opacity: 1, y: 0, duration: 0.65, stagger: 0.14, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.25,
      );
      tl.add(() => {
        if (onStage) startFigures();
      }, 0.55);
    },
    onEnter() {
      if (onStage) return;
      onStage = true;
      startFigures();
    },
    onLeave() {
      onStage = false;
      stopFigures();
    },
    destroy() {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      killEntrance();
      stopFigures();
    },
  };
};

export default buildManual;
