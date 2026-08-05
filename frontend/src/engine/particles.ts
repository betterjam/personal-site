/**
 * The Candy Apple particle swarm, ported from the Mixtape mockup WITH
 * recolor-in-flight: each particle carries a color index into a source
 * swatch set (cf) and one into a target set (ct); a recolor scalar tweens
 * the blend mid-flight so the swarm itself carries you between finishes.
 *
 * Three uses in the deck app:
 *   1. intro()    — the swarm paints the hub headline on first load;
 *   2. morph()    — THE section transition: the outgoing headline shatters
 *                   in the outgoing finish's swatches, the swarm recolors
 *                   in flight and converges on the incoming headline while
 *                   the deck swaps the DOM underneath. Interruptible: a
 *                   retarget keeps the same swarm flying — rendered
 *                   positions become new origins, the target palette
 *                   becomes the source.
 *   3. flourish() — a small non-blocking burst from a clicked card/button.
 *
 * Canvas #fx is fixed and DPR-aware; rendering rides gsap.ticker and the
 * ticker is removed whenever no effect is alive.
 */
import { gsap } from 'gsap';
import { MIXTAPE } from './data';
import { SWATCHES, pickIdx, type Swatch } from './themes';

interface Particle {
  cf: number;
  ct: number;
  tw: boolean;
  size: number;
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /** Last rendered position — a retargeted morph takes off from here. */
  rx: number;
  ry: number;
  lag: number;
  lagc: number;
  amp: number;
  amp2: number;
  f1: number;
  f2: number;
  ph: number;
  ph2: number;
  twf: number;
}

/** disperse, converge, wobble, alpha, recolor — one scalar set per effect. */
interface Pp {
  d: number;
  c: number;
  w: number;
  a: number;
  r: number;
}

interface Effect {
  particles: Particle[];
  pp: Pp;
  from: Swatch[];
  to: Swatch[];
  tl: gsap.core.Timeline;
  done: boolean;
  comboCache: string[];
  comboR: number;
}

export interface IntroHandle {
  tl: gsap.core.Timeline;
  /** Timeline position (s) where the swarm has settled on the headline. */
  land: number;
}

export interface MorphSpec {
  /** Palette the swarm shatters in (ignored on a retarget). */
  fromThemeId: string;
  /** Palette the swarm recolors toward mid-flight. */
  toThemeId: string;
  /**
   * Outgoing glyph anchor. null (or unsampleable) → the swarm seeds from
   * a loose field across the viewport instead. Ignored on a retarget —
   * the flying swarm's rendered positions are the new origins.
   */
  fromHeadline: HTMLElement | null;
  /**
   * Called at the explosion's peak: swap the DOM underneath and return
   * the incoming headline to converge on (null → the swarm holds its
   * scatter and simply fades).
   */
  onSwap(): HTMLElement | null;
  /** The swarm has settled on the incoming headline — reveal the DOM. */
  onLand(): void;
  /** Transition finished and the swarm faded out. */
  onComplete(): void;
}

export interface ParticleEngine {
  /**
   * First-load paint: the swarm converges from a loose field onto the
   * headline's glyphs. Returns null (and does nothing) when motion is
   * reduced or the headline cannot be sampled — callers fall back to
   * showing the DOM instantly.
   */
  intro(headline: HTMLElement, themeId: string): IntroHandle | null;
  /**
   * THE scroll transition. Starts (or retargets) the deck morph. When a
   * morph is already in flight the same swarm keeps flying and re-aims:
   * rendered positions become new origins, the palette it was heading
   * toward becomes its source, and the old timeline's pending callbacks
   * die with it. Returns false only when the canvas is unavailable or
   * motion is reduced — callers fall back to a crossfade/instant swap.
   */
  morph(spec: MorphSpec): boolean;
  /** A deck morph is currently in flight. */
  morphActive(): boolean;
  /** Kill the in-flight morph (if any) without touching other effects. */
  killMorph(): void;
  /**
   * Non-blocking click burst: ~400 particles seeded in fromEl's rect,
   * dispersing while they recolor from fromThemeId's swatches toward
   * toThemeId's, then fading out. No-op under reduced motion.
   */
  flourish(fromEl: Element, fromThemeId: string, toThemeId: string): void;
  /** Kill every live effect and clear the canvas (reduced-motion flip). */
  killAll(): void;
  destroy(): void;
}

const TEMPO = MIXTAPE.transition.tempo;
const PARAMS = MIXTAPE.transition.params;
const FLOURISH_COUNT = 400;
const FLOURISH_COUNT_SMALL = 240;
const MAX_FLOURISHES = 3;

function makeParticle(from: Swatch[], sizeScale: number): Particle {
  return {
    cf: pickIdx(from),
    ct: 0,
    tw: Math.random() < 0.16,
    size: (2 + Math.random()) * sizeScale,
    ox: 0,
    oy: 0,
    sx: 0,
    sy: 0,
    tx: 0,
    ty: 0,
    rx: 0,
    ry: 0,
    lag: Math.random() * 0.22,
    lagc: Math.random() * 0.3,
    amp: 5 + Math.random() * 18,
    amp2: 2 + Math.random() * 9,
    f1: 0.5 + Math.random() * 1.6,
    f2: 1.1 + Math.random() * 2.4,
    ph: Math.random() * 6.2832,
    ph2: Math.random() * 6.2832,
    twf: 2.5 + Math.random() * 5,
  };
}

function sortPool(particles: Particle[]): void {
  /* batch canvas fillStyle switches: group by color combo */
  particles.sort((a, b) => a.cf * 8 + a.ct - (b.cf * 8 + b.ct));
}

function localP(g: number, l: number): number {
  return g <= l ? 0 : (g - l) / (1 - l);
}

export function createParticleEngine(
  canvas: HTMLCanvasElement,
  reduced: () => boolean,
): ParticleEngine {
  const ctx = canvas.getContext('2d');
  const raster = document.createElement('canvas');
  const rctx = raster.getContext('2d', { willReadFrequently: true });

  let vw = 0;
  let vh = 0;
  let dpr = 1;
  let scatterPx = 0;
  const effects: Effect[] = [];
  let tickerOn = false;

  function sizeCanvas(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth;
    vh = window.innerHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    scatterPx = (PARAMS.scatterRadiusVmax / 100) * Math.max(vw, vh);
  }

  function ensureTicker(): void {
    if (!tickerOn) {
      tickerOn = true;
      gsap.ticker.add(render);
    }
  }
  function stopTicker(): void {
    if (tickerOn) {
      tickerOn = false;
      gsap.ticker.remove(render);
    }
    ctx?.clearRect(0, 0, vw, vh);
  }

  function comboColor(fx: Effect, key: number, cf: number, ct: number): string {
    let c = fx.comboCache[key];
    if (!c) {
      const A = fx.from[cf].rgb;
      const B = fx.to[ct].rgb;
      const t = fx.pp.r;
      c = fx.comboCache[key] =
        'rgb(' +
        Math.round(A[0] + (B[0] - A[0]) * t) +
        ',' +
        Math.round(A[1] + (B[1] - A[1]) * t) +
        ',' +
        Math.round(A[2] + (B[2] - A[2]) * t) +
        ')';
    }
    return c;
  }

  function drawEffect(fx: Effect, t: number): void {
    if (!ctx) return;
    const pp = fx.pp;
    if (pp.a <= 0.001) return;
    if (pp.r !== fx.comboR) {
      fx.comboR = pp.r;
      fx.comboCache.length = 0;
    }
    let lastKey = -1;
    const particles = fx.particles;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      let x: number;
      let y: number;
      let k: number;
      if (pp.c > 0) {
        k = localP(pp.c, p.lagc);
        if (k > 1) k = 1;
        x = p.sx + (p.tx - p.sx) * k;
        y = p.sy + (p.ty - p.sy) * k;
      } else {
        k = localP(pp.d, p.lag);
        if (k > 1) k = 1;
        x = p.ox + (p.sx - p.ox) * k;
        y = p.oy + (p.sy - p.oy) * k;
      }
      if (pp.w > 0.001) {
        x += pp.w * (Math.sin(t * p.f1 + p.ph) * p.amp + Math.sin(t * p.f2 + p.ph2) * p.amp2);
        y += pp.w * (Math.cos(t * p.f1 * 0.83 + p.ph2) * p.amp + Math.cos(t * p.f2 * 1.13 + p.ph) * p.amp2);
      }
      p.rx = x;
      p.ry = y;
      if (x < -8 || x > vw + 8 || y < -8 || y > vh + 8) continue;
      let al = pp.a;
      if (p.tw) al *= 0.5 + 0.5 * Math.sin(t * p.twf + p.ph);
      if (al <= 0.01) continue;
      const key = p.cf * 8 + p.ct;
      if (key !== lastKey) {
        lastKey = key;
        ctx.fillStyle = comboColor(fx, key, p.cf, p.ct);
      }
      ctx.globalAlpha = al > 1 ? 1 : al;
      const sz = p.size;
      ctx.fillRect(x - sz * 0.5, y - sz * 0.5, sz, sz);
    }
  }

  function render(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, vw, vh);
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i].done) effects.splice(i, 1);
    }
    if (!effects.length) {
      stopTicker();
      return;
    }
    const t = gsap.ticker.time;
    ctx.globalCompositeOperation = 'lighter';
    for (const fx of effects) drawEffect(fx, t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------------- glyph sampling (rasterize a headline offscreen) ------ */

  function samplePoints(elm: HTMLElement): number[] | null {
    if (!rctx) return null;
    const rect = elm.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    const cs = window.getComputedStyle(elm);
    const fontSize = parseFloat(cs.fontSize) || 16;
    let lineH = parseFloat(cs.lineHeight);
    if (!lineH || isNaN(lineH)) lineH = fontSize * 1.05;
    const w = Math.ceil(rect.width) + 4;
    const h = Math.ceil(rect.height) + Math.ceil(lineH * 0.5);
    raster.width = w;
    raster.height = h;
    rctx.clearRect(0, 0, w, h);
    rctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const stretch = parseFloat(cs.fontStretch);
    if (!isNaN(stretch) && stretch <= 87.5) {
      /* invalid values are ignored, leaving the plain shorthand in place */
      rctx.font = `${cs.fontWeight} condensed ${cs.fontSize} ${cs.fontFamily}`;
    }
    if ('letterSpacing' in rctx && cs.letterSpacing && cs.letterSpacing !== 'normal') {
      try {
        (rctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
          cs.letterSpacing;
      } catch {
        /* older engines: skip */
      }
    }
    rctx.textBaseline = 'alphabetic';
    rctx.fillStyle = '#ffffff'; /* offscreen mask only — visible colors come from theme swatches */
    let text = (elm.textContent || '').replace(/\s+/g, ' ').trim();
    if (cs.textTransform === 'uppercase') text = text.toUpperCase();
    if (!text) return null;
    const words = text.split(' ');
    const linesArr: string[] = [];
    let cur = '';
    for (const word of words) {
      const probe = cur ? cur + ' ' + word : word;
      if (cur && rctx.measureText(probe).width > rect.width + 2) {
        linesArr.push(cur);
        cur = word;
      } else {
        cur = probe;
      }
    }
    if (cur) linesArr.push(cur);
    const m = rctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || fontSize * 0.8;
    const desc = m.fontBoundingBoxDescent || fontSize * 0.22;
    const y0 = (lineH - (asc + desc)) / 2 + asc;
    for (let li = 0; li < linesArr.length; li++) {
      rctx.fillText(linesArr[li], 0, y0 + li * lineH);
    }
    let data: Uint8ClampedArray;
    try {
      data = rctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
    const pts: number[] = [];
    const step = 2;
    for (let yy = 0; yy < h; yy += step) {
      const row = yy * w;
      for (let xx = 0; xx < w; xx += step) {
        if (data[(row + xx) * 4 + 3] > 120) pts.push(rect.left + xx, rect.top + yy);
      }
    }
    return pts.length >= 24 ? pts : null;
  }

  function assign(
    particles: Particle[],
    pts: number[],
    keyX: 'ox' | 'sx' | 'tx',
    keyY: 'oy' | 'sy' | 'ty',
    jitter: number,
  ): void {
    const n = particles.length;
    const m = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const idx = m <= n ? i % m : Math.floor((i * m) / n);
      const p = particles[i];
      p[keyX] = pts[idx * 2] + (Math.random() - 0.5) * jitter;
      p[keyY] = pts[idx * 2 + 1] + (Math.random() - 0.5) * jitter;
    }
  }

  /* --------------------------------------------------------------- intro */

  function intro(headline: HTMLElement, themeId: string): IntroHandle | null {
    if (reduced() || !ctx) return null;
    const pts = samplePoints(headline);
    if (!pts) return null;

    const sw = SWATCHES[themeId];
    const count = vw < 768 ? 850 : PARAMS.particleCount;
    const sizeScale = PARAMS.particleSizePx / 2.5;
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const p = makeParticle(sw, sizeScale);
      p.ct = p.cf;
      p.ox = Math.random() * vw;
      p.oy = vh * 0.15 + Math.random() * vh * 1.05;
      p.sx = p.ox;
      p.sy = p.oy;
      particles.push(p);
    }
    sortPool(particles);
    assign(particles, pts, 'tx', 'ty', 1.6);

    const pp: Pp = { d: 1, c: 0, w: 1, a: 0, r: 0 };
    const fx: Effect = {
      particles,
      pp,
      from: sw,
      to: sw,
      tl: gsap.timeline(),
      done: false,
      comboCache: [],
      comboR: -1,
    };
    const tl = fx.tl;
    tl.eventCallback('onComplete', () => {
      fx.done = true;
    });
    tl.to(pp, { a: 1, duration: 0.5, ease: 'power1.out' }, 0.05);
    tl.to(pp, { c: 1, duration: TEMPO.converge + 0.5, ease: 'power3.out' }, 0.2);
    tl.to(pp, { w: 0, duration: 1.1, ease: 'sine.inOut' }, 0.5);
    const land = 0.2 + TEMPO.converge + 0.5;
    tl.to(pp, { a: 0, duration: TEMPO.reveal + 0.2, ease: 'power1.in' }, land + 0.1);

    effects.push(fx);
    ensureTicker();
    return { tl, land };
  }

  /* --------------------------------------------------------------- morph
     THE deck transition, ported from the mockup's particleGo() with the
     interruption pattern intact: one persistent pool, one Effect that
     lives across retargets. */

  let morphPool: Particle[] = [];
  let morphFx: Effect | null = null;

  function morphPoolEnsure(from: Swatch[]): Particle[] {
    const count = vw < 768 ? 850 : PARAMS.particleCount;
    const sizeScale = PARAMS.particleSizePx / 2.5;
    if (morphPool.length !== count) {
      morphPool = [];
      for (let i = 0; i < count; i++) morphPool.push(makeParticle(from, sizeScale));
    } else {
      for (const p of morphPool) p.cf = pickIdx(from);
    }
    return morphPool;
  }

  /** Scatter destinations around each particle's origin (the explosion). */
  function setScatter(particles: Particle[]): void {
    for (const p of particles) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.pow(Math.random(), 0.72) * scatterPx;
      p.sx = p.ox + Math.cos(a) * d;
      p.sy = p.oy + Math.sin(a) * d * 0.85 + (0.12 + 0.38 * Math.random()) * scatterPx * 0.55;
    }
  }

  function morphActive(): boolean {
    return morphFx != null && !morphFx.done;
  }

  function killMorph(): void {
    if (morphFx) {
      morphFx.tl.kill();
      morphFx.done = true;
      morphFx = null;
    }
  }

  function morph(spec: MorphSpec): boolean {
    if (reduced() || !ctx) return false;
    const live = morphActive() ? morphFx : null;

    if (live) {
      /* retarget: the same swarm carries on — rendered positions become
         the new origins, and the palette it was heading toward becomes
         its source. Keep w and a where they are. */
      live.tl.kill();
      live.from = live.to;
      for (const p of live.particles) {
        p.cf = p.ct;
        p.ox = p.rx;
        p.oy = p.ry;
      }
      live.pp.d = 0;
      live.pp.c = 0;
      live.pp.r = 0;
    } else {
      const from = SWATCHES[spec.fromThemeId];
      const particles = morphPoolEnsure(from);
      const pts = spec.fromHeadline ? samplePoints(spec.fromHeadline) : null;
      if (pts) {
        assign(particles, pts, 'ox', 'oy', 2);
      } else {
        /* no glyphs to shatter — dust lifts off the whole view instead */
        for (const p of particles) {
          p.ox = Math.random() * vw;
          p.oy = Math.random() * vh;
        }
      }
      morphFx = {
        particles,
        pp: { d: 0, c: 0, w: 0, a: 0, r: 0 },
        from,
        to: from,
        tl: gsap.timeline(),
        done: false,
        comboCache: [],
        comboR: -1,
      };
      effects.push(morphFx);
    }

    const fx = morphFx as Effect;
    fx.to = SWATCHES[spec.toThemeId];
    for (const p of fx.particles) p.ct = pickIdx(fx.to);
    sortPool(fx.particles);
    fx.comboCache.length = 0;
    fx.comboR = -1;
    setScatter(fx.particles);
    ensureTicker();

    const pp = fx.pp;
    const tl = gsap.timeline();
    fx.tl = tl;
    tl.eventCallback('onComplete', () => {
      fx.done = true;
      if (morphFx === fx) morphFx = null;
      spec.onComplete();
    });

    /* ignition: particles take over the glyph positions as the DOM hides */
    tl.to(pp, { a: 1, duration: 0.12, ease: 'none' }, 0);

    /* destroy — tinted in the current view's palette */
    tl.to(pp, { d: 1, duration: TEMPO.disperse, ease: 'power2.in' }, 0);
    tl.to(pp, { w: 1, duration: Math.max(0.3, TEMPO.disperse * 0.5), ease: 'sine.out' }, 0.12);

    /* recolor in flight: mid-swarm the channels tween toward the target */
    tl.to(
      pp,
      { r: 1, duration: TEMPO.swarm + TEMPO.converge * 0.5, ease: 'sine.inOut' },
      TEMPO.disperse * 0.6,
    );

    /* swap views at the peak of the explosion, sample the incoming headline */
    tl.call(
      () => {
        const target = spec.onSwap();
        const tp = target ? samplePoints(target) : null;
        if (tp) {
          assign(fx.particles, tp, 'tx', 'ty', 1.6);
        } else {
          for (const p of fx.particles) {
            p.tx = p.sx;
            p.ty = p.sy;
          }
        }
      },
      undefined,
      TEMPO.disperse,
    );

    /* create */
    const convergeAt = TEMPO.disperse + TEMPO.swarm;
    tl.to(pp, { c: 1, duration: TEMPO.converge, ease: 'power3.out' }, convergeAt);
    tl.to(pp, { w: 0, duration: TEMPO.converge * 0.6, ease: 'sine.inOut' }, convergeAt + 0.15);

    /* reveal: the DOM crossfades in over the settled swarm */
    const land = convergeAt + TEMPO.converge;
    tl.call(() => spec.onLand(), undefined, land);
    tl.to(pp, { a: 0, duration: TEMPO.reveal + 0.15, ease: 'power1.in' }, land + 0.08);
    return true;
  }

  /* ------------------------------------------------------------ flourish */

  function flourish(fromEl: Element, fromThemeId: string, toThemeId: string): void {
    if (reduced() || !ctx) return;
    const rect = fromEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    /* cap the pileup: the oldest flourish yields — never the deck morph */
    const live = effects.filter((e) => !e.done && e !== morphFx);
    if (live.length >= MAX_FLOURISHES) {
      const oldest = live[0];
      oldest.tl.kill();
      oldest.done = true;
    }

    const from = SWATCHES[fromThemeId];
    const to = SWATCHES[toThemeId];
    const count = vw < 768 ? FLOURISH_COUNT_SMALL : FLOURISH_COUNT;
    const sizeScale = PARAMS.particleSizePx / 2.5;
    const burstR = Math.min(scatterPx * 0.5, Math.max(vw, vh) * 0.3);
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const p = makeParticle(from, sizeScale);
      p.ct = pickIdx(to);
      p.ox = rect.left + Math.random() * rect.width;
      p.oy = rect.top + Math.random() * rect.height;
      const a = Math.random() * Math.PI * 2;
      const d = Math.pow(Math.random(), 0.72) * burstR;
      p.sx = p.ox + Math.cos(a) * d;
      p.sy = p.oy + Math.sin(a) * d * 0.85 - (0.1 + 0.3 * Math.random()) * burstR * 0.4;
      particles.push(p);
    }
    sortPool(particles);

    const pp: Pp = { d: 0, c: 0, w: 0, a: 1, r: 0 };
    const fx: Effect = {
      particles,
      pp,
      from,
      to,
      tl: gsap.timeline(),
      done: false,
      comboCache: [],
      comboR: -1,
    };
    const tl = fx.tl;
    tl.eventCallback('onComplete', () => {
      fx.done = true;
    });
    tl.to(pp, { d: 1, duration: 0.9, ease: 'power2.out' }, 0);
    tl.to(pp, { w: 1, duration: 0.35, ease: 'sine.out' }, 0);
    tl.to(pp, { r: 1, duration: 0.5, ease: 'sine.inOut' }, 0.12);
    tl.to(pp, { a: 0, duration: 0.55, ease: 'power1.in' }, 0.4);

    effects.push(fx);
    ensureTicker();
  }

  /* ------------------------------------------------------------ plumbing */

  function killAll(): void {
    for (const fx of effects) {
      fx.tl.kill();
      fx.done = true;
    }
    effects.length = 0;
    morphFx = null;
    stopTicker();
  }

  let rzT: ReturnType<typeof setTimeout> | null = null;
  const onResize = (): void => {
    if (rzT) clearTimeout(rzT);
    rzT = setTimeout(sizeCanvas, 160);
  };
  window.addEventListener('resize', onResize);

  sizeCanvas();

  return {
    intro,
    morph,
    morphActive,
    killMorph,
    flourish,
    killAll,
    destroy() {
      killAll();
      window.removeEventListener('resize', onResize);
      if (rzT) clearTimeout(rzT);
    },
  };
}
