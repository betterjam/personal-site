/**
 * Boot — assemble the DECK: rail chrome from the hub finish, every view
 * (hub + sections in content.json order) built once as a fixed panel
 * wearing its mixtape finish, a body-height track keeping a real
 * scrollbar. The Candy Apple swarm paints the intro AND carries every
 * section change: scrolling (or navigating) morphs the outgoing headline
 * into the incoming one — the swarm IS the transition, no seams.
 */
/* Self-hosted webfonts (Fontsource): one face per finish, mapped through
   the theme JSONs' type stacks. Variable where available, woff2 only. */
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/jost';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/newsreader/wght-italic.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/archivo-black';
import './styles/base.css';
import { gsap } from 'gsap';
import {
  CONTENT,
  MIXTAPE,
  ROADMAP,
  THEMES,
  fetchMeta,
  fetchPages,
  type MixtapeSection,
} from './engine/data';
import { abbr, accentOf, applyTokens, pad2, stageOf } from './engine/themes';
import { createParticleEngine } from './engine/particles';
import { initDeck, type DeckView } from './engine/scroll';
import { initScrollIndicator } from './engine/scrollIndicator';
import { initCursor } from './engine/cursor';
import type { SectionBuilder, SectionCtx, SectionInstance } from './sections/types';
import { HUB_ID, buildHub } from './sections/hub';
import { buildStrips } from './sections/strips';
import { buildControlPanel } from './sections/controlPanel';
import { buildStage } from './sections/stage';
import { buildOrbit } from './sections/orbit';
import { buildShowcase } from './sections/showcase';
import { buildPatchBay } from './sections/patchBay';
import { buildStream } from './sections/stream';
import { buildPedals } from './sections/pedals';
import { buildEditorial } from './sections/editorial';
import { buildBlog } from './sections/blog';
import { initMaintain } from './maintain';
import { initPageRoom } from './pageRoom';

const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = (): boolean => mqReduced.matches;

const root = document.documentElement;
const appEl = document.getElementById('app');
if (!appEl) throw new Error('missing #app mount point');

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

/* ---------------- shell: fx canvas, rail, main (the deck) ---------------- */

const canvas = el('canvas');
canvas.id = 'fx';
canvas.setAttribute('aria-hidden', 'true');

const railEl = el('header', 'mixrail');
const brand = el('p', 'mx-brand');
brand.appendChild(el('span', 'mx-name', CONTENT.profile.name));
brand.appendChild(el('span', 'mx-role', CONTENT.profile.role));
const navEl = el('nav', 'mx-nav');
navEl.setAttribute('aria-label', 'Sections');
const navRow = el('div', 'mx-nav-row');
navEl.appendChild(navRow);
railEl.appendChild(brand);
railEl.appendChild(navEl);

const mainEl = el('main');
mainEl.id = 'mx-main';

const footEl = el('footer', 'mixfoot');
const footRow = el('div', 'mx-foot-row');
footEl.appendChild(footRow);

appEl.appendChild(canvas);
appEl.appendChild(railEl);
appEl.appendChild(mainEl);
/* the footer rides the LAST view's inner scroll (appended after build) */

/* rail + footer wear the hub finish; chrome/gold feed the shimmer */
const hubTheme = THEMES[MIXTAPE.hub.theme];
const candyPal = THEMES['candy-particles'].palette;
for (const node of [railEl, footEl]) {
  node.style.setProperty('--mx-bg', hubTheme.palette.graphite);
  node.style.setProperty('--mx-ink', hubTheme.palette.bone);
  node.style.setProperty('--font-display', hubTheme.type.display.stack);
  node.style.setProperty('--font-body', hubTheme.type.body.stack);
  node.style.setProperty('--font-mono', hubTheme.type.utility.stack);
}
railEl.style.setProperty('--mx-chrome', candyPal.chrome);
railEl.style.setProperty('--mx-gold', candyPal.goldBase);
document.body.style.setProperty('--mx-stage', stageOf(MIXTAPE.hub.theme));
root.style.setProperty('--mx-accent', accentOf(MIXTAPE.hub.theme, null));

/* the deck's fixed panels start just below the sticky rail */
function setRailVar(): void {
  root.style.setProperty('--mx-rail-h', railEl.offsetHeight + 'px');
}

/* ------------------------------- footer --------------------------------- */

const mail = el('a', 'mx-mail', CONTENT.profile.contact);
mail.href = 'mailto:' + CONTENT.profile.contact;
footRow.appendChild(mail);
const flinks = el('span', 'mx-flinks');
for (const lnk of CONTENT.profile.links ?? []) {
  const a = el('a', 'mx-flink', lnk.label);
  a.href = lnk.url;
  a.target = '_blank';
  a.rel = 'noopener';
  flinks.appendChild(a);
}
footRow.appendChild(flinks);
footRow.appendChild(el('span', 'mx-loc', CONTENT.profile.location));
footRow.appendChild(el('span', 'mx-chip', 'Mixtape — every finish, one content.json'));
/* published pages land here after boot — quiet links beside 'maintain' */
const pagesSlot = el('span', 'mx-pages');
footRow.appendChild(pagesSlot);
/* the quiet way in: the maintainer console rides its own hash route */
const maintainLink = el('a', 'mx-maintain', 'maintain');
maintainLink.href = '#/maintain';
footRow.appendChild(maintainLink);

/* ------------------------------ engines --------------------------------- */

const particles = createParticleEngine(canvas, reduced);
initCursor();

/* ------------------------------ rail nav -------------------------------- */

interface NavEntry {
  id: string;
  btn: HTMLButtonElement;
}
const navEntries: NavEntry[] = [];

function themeOf(viewId: string): string {
  return viewId === HUB_ID ? MIXTAPE.hub.theme : MIXTAPE.sections[viewId].theme;
}

function navButton(label: string, idx: number, targetId: string): void {
  const b = el('button', 'mx-btn');
  b.type = 'button';
  b.appendChild(el('span', 'mx-idx', pad2(idx)));
  b.appendChild(el('span', 'mx-lbl', label));
  b.addEventListener('click', () => {
    deck.goTo(viewIndexOf(targetId));
  });
  navRow.appendChild(b);
  navEntries.push({ id: targetId, btn: b });
}

/* clipped tabs get a fading edge instead of a hard cut */
function navEdges(): void {
  const max = navEl.scrollWidth - navEl.clientWidth;
  navEl.classList.toggle('has-more-l', navEl.scrollLeft > 1);
  navEl.classList.toggle('has-more-r', navEl.scrollLeft < max - 1);
}
navEl.addEventListener('scroll', navEdges, { passive: true });

function markNavActive(viewId: string): void {
  const isChrome = themeOf(viewId) === 'candy-particles';
  for (const entry of navEntries) {
    const on = entry.id === viewId;
    entry.btn.classList.toggle('is-active', on);
    entry.btn.classList.toggle('is-chrome', on && isChrome);
    if (on) {
      entry.btn.setAttribute('aria-current', 'true');
      entry.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      entry.btn.removeAttribute('aria-current');
    }
  }
}

/* ------------------------- section registry ----------------------------- */

const RENDERERS: Record<string, SectionBuilder> = {
  orbit: buildOrbit,
  showcase: buildShowcase,
  strips: buildStrips,
  'control-panel': buildControlPanel,
  stage: buildStage,
  'patch-bay': buildPatchBay,
  stream: buildStream,
  pedals: buildPedals,
  editorial: buildEditorial,
};
/** Section-id overrides win over the renderer mapping (live blog). */
const BY_SECTION_ID: Record<string, SectionBuilder> = {
  blog: buildBlog,
};

function makeCtx(mix: MixtapeSection): SectionCtx {
  return {
    reduced,
    applyTokens,
    accentOf,
    stageOf,
    abbr,
    themes: THEMES,
    mix,
  };
}

interface AppView {
  id: string;
  themeId: string;
  accent: string;
  stage: string;
  instance: SectionInstance;
}
const views: AppView[] = [];

function viewIndexOf(id: string): number {
  const i = views.findIndex((v) => v.id === id);
  return i >= 0 ? i : 0;
}

/* hub first */
const hub = buildHub(
  mainEl,
  CONTENT,
  makeCtx({ theme: MIXTAPE.hub.theme, renderer: MIXTAPE.hub.renderer }),
  {
    roadmap: ROADMAP.items,
    buildInfo: __BUILD_INFO__,
    meta: fetchMeta(),
    onCardClick(sectionId) {
      deck.goTo(viewIndexOf(sectionId));
    },
    onLayoutChange() {
      deck.refresh();
    },
  },
);
views.push({
  id: HUB_ID,
  themeId: MIXTAPE.hub.theme,
  accent: accentOf(MIXTAPE.hub.theme, null),
  stage: stageOf(MIXTAPE.hub.theme),
  instance: hub,
});
navButton('Overview', 0, HUB_ID);

/* then every section view, JSON order */
CONTENT.sections.forEach((section, i) => {
  const conf = MIXTAPE.sections[section.id];
  if (!conf) {
    console.warn(`no mixtape mapping for section '${section.id}' — skipped`);
    return;
  }
  const builder = BY_SECTION_ID[section.id] ?? RENDERERS[conf.renderer];
  if (!builder) {
    console.warn(`no renderer '${conf.renderer}' for section '${section.id}' — skipped`);
    return;
  }
  const instance = builder(mainEl, section, i, makeCtx(conf));
  views.push({
    id: section.id,
    themeId: conf.theme,
    accent: accentOf(conf.theme, section.id),
    stage: stageOf(conf.theme),
    instance,
  });
  navButton(section.label, i + 1, section.id);
});
navEdges();

/* the footer remains reachable: it ends the LAST view's inner scroll */
views[views.length - 1].instance.el.appendChild(footEl);

/* ------------------------------ the deck -------------------------------- */

setRailVar();

/** '#<sectionId>' → that view; '#/blog/…' (overlay namespace) → the blog
    view so the reading room has a live host; other overlays ('#/page/…',
    '#/maintain') sit over the hub; anything else → hub. */
function initialIndexFromHash(): number {
  const h = location.hash;
  if (!h || h === '#') return 0;
  if (h.startsWith('#/')) {
    return /^#\/blog\//.test(h) ? viewIndexOf('blog') : 0;
  }
  let id = h.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* malformed escape — treat the raw fragment as the id */
  }
  const i = views.findIndex((v) => v.id === id);
  return i >= 0 ? i : 0;
}

const initialIndex = initialIndexFromHash();
const introWillRun = initialIndex === 0 && !reduced();

/* the scroll indicator — floating capsule at the right edge: entries in
   deck order, clicks through the same goTo path as the rail buttons */
const sectionLabels = new Map(CONTENT.sections.map((s): [string, string] => [s.id, s.label]));
const indicator = initScrollIndicator({
  views: views.map((v) => ({
    id: v.id,
    label: v.id === HUB_ID ? 'Overview' : (sectionLabels.get(v.id) ?? v.id),
    stage: v.stage,
  })),
  reduced,
  onSelect(id) {
    deck.goTo(viewIndexOf(id));
  },
});
/* the hints speak the same mono the rail does */
indicator.el.style.setProperty('--font-mono', hubTheme.type.utility.stack);

const deckViews: DeckView[] = views.map((v) => ({
  id: v.id,
  el: v.instance.el,
  headline: v.instance.headline,
  themeId: v.themeId,
  accent: v.accent,
  stage: v.stage,
  rise: v.id === HUB_ID ? hub.rise : undefined,
  prepareEntrance: () => v.instance.prepareEntrance(),
  playEntrance: () => v.instance.playEntrance(),
  onEnter: () => v.instance.onEnter?.(),
  onLeave: () => v.instance.onLeave?.(),
}));

const deck = initDeck(deckViews, {
  reduced,
  particles,
  trackHost: appEl,
  initialIndex,
  skipInitialEntrance: introWillRun,
  revealSeconds: MIXTAPE.transition.tempo.reveal,
  onViewTargeted(id) {
    /* rail + indicator stay in lockstep — targeting, landing and the
       hash deep-link boot all funnel through this one callback */
    markNavActive(id);
    indicator.setActive(id);
  },
});

/* the maintainer console — a body-level overlay on '#/maintain', built
   after the deck so its deep-link microtask lands on a seated scrollbar */
initMaintain(reduced);

/* the page reading room — same body-level overlay idiom on '#/page/:slug',
   Seafoam finish; deep links land over whatever view the hash routed to */
initPageRoom(reduced);

/* published pages → quiet footer links, async and silent on failure
   (an empty pages list is a real state — the footer just stays quiet) */
void fetchPages()
  .then((pages) => {
    for (const pg of pages) {
      const a = el('a', 'mx-pagelink', pg.title);
      a.href = '#/page/' + encodeURIComponent(pg.slug);
      pagesSlot.appendChild(a);
    }
  })
  .catch(() => {
    /* API offline or pages not deployed yet — nothing to add */
  });

/* ----------------- intro: the swarm paints the name --------------------- */

function runIntro(): void {
  if (!introWillRun) {
    indicator.reveal(); /* reduced motion or deep link — no intro to wait on */
    return;
  }
  const handle = particles.intro(hub.headline, MIXTAPE.hub.theme);
  if (!handle) {
    indicator.reveal();
    return; /* sampling failed: everything stays visible */
  }
  const T = MIXTAPE.transition.tempo;
  gsap.set(hub.headline, { autoAlpha: 0 });
  gsap.set(hub.rise, { autoAlpha: 0, y: 22 });
  gsap.set(railEl, { autoAlpha: 0 });
  const { tl, land } = handle;
  tl.to(railEl, { autoAlpha: 1, duration: 0.6, ease: 'none', clearProps: 'opacity,visibility' }, 0.35);
  tl.to(hub.headline, { autoAlpha: 1, duration: T.reveal, ease: 'power1.inOut' }, land);
  tl.to(
    hub.rise,
    {
      autoAlpha: 1,
      y: 0,
      duration: 0.55,
      stagger: 0.05,
      ease: 'power2.out',
      clearProps: 'opacity,visibility,transform',
    },
    land + T.reveal * 0.7,
  );
  tl.call(() => indicator.reveal(), undefined, land + T.reveal * 0.7);
}
runIntro();

/* motion preference flipped mid-flight: settle everything instantly */
function onReducedChange(): void {
  if (!mqReduced.matches) {
    deck.syncMotion(); /* snap comes back */
    return;
  }
  particles.killAll();
  indicator.reveal(); /* the intro may die before its reveal cue fires */
  deck.syncMotion(); /* settles any in-flight morph on the latest target */
  const settled = [hub.headline, ...hub.rise, railEl];
  gsap.killTweensOf(settled);
  gsap.set(settled, { clearProps: 'opacity,visibility,transform' });
}
if (typeof mqReduced.addEventListener === 'function') {
  mqReduced.addEventListener('change', onReducedChange);
}

/* --------------------------- resize / settle ----------------------------- */

let rzT: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
  navEdges();
  if (rzT) clearTimeout(rzT);
  rzT = setTimeout(() => {
    setRailVar();
    deck.refresh(); /* recompute slots, keep the displayed view stable */
  }, 160);
});

/* layout settles → measure again (fonts change the rail height) */
requestAnimationFrame(() => {
  setRailVar();
  deck.refresh();
});
if (document.fonts?.ready) {
  void document.fonts.ready.then(() => {
    setRailVar();
    deck.refresh();
  });
}
window.addEventListener(
  'load',
  () => {
    setRailVar();
    deck.refresh();
  },
  { once: true },
);
