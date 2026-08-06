/**
 * SHOWCASE — the Seafoam Swiss case-study renderer (mixtape 'showcase';
 * serves 'projects' in the current tape). After the section head, every
 * project is a case-study row: a browser-framed snapshot on one side,
 * copy (index, title, summary, tags, 'Read the case study →') on the
 * other, alternating sides row by row; stacked cleanly under 900px.
 * Generous whitespace, hairlines only.
 *
 * PAGE BLOCKS — the projects section no longer authors its copy inline.
 * Each item is { "page": "<slug>", "tags": [...] } and the copy comes from
 * the published page itself (title + summary, or its first paragraph),
 * resolved async through resolvePageCardEntry(). Consequences, by design:
 *   - the row paints IMMEDIATELY as a frame plus a title placeholder and
 *     fills in when the page lands — the band never waits on the network;
 *   - the whole copy card is a real anchor to '#/page/<slug>', so the
 *     reading room opens with a genuine history entry behind it;
 *   - a row is REMOVED only on a 'hidden' resolution — the LIVE API said
 *     the page is unpublished, or no such slug exists in the API or the
 *     bundled snapshot. An API that is switched off resolves from the
 *     snapshot instead: this band is the site's flagship section and an
 *     unreachable backend must never be able to empty it (that is exactly
 *     what it used to do, and why the snapshot exists);
 *   - a page that names a `repo` gets the GitHub widget under its copy
 *     (engine/repoCard.ts). It is a second link, so it sits BESIDE the
 *     copy anchor in the row's copy column, never nested inside it.
 *
 * SNAPSHOT POLICY — visual evidence, never fake screenshots:
 *   - a page that declares an `image` shows it (asset: tokens resolve
 *     through engine/assets.ts, https URLs are used directly);
 *   - real captures are used where they exist (architecture/dashboard
 *     .webp captures are picked up automatically if dropped in
 *     src/assets);
 *   - everything else keeps its per-slug illustrative frame (tiered nodes
 *     + wires, service cards + toggles, abstract storefront blocks) drawn
 *     in the seafoam/graphite palette — no brand mimicry, no fake copy
 *     pretending to be a screenshot.
 *
 * Entrance (deck lifecycle): the kicker/summary rise (the headline is
 * the particle morph's — the deck reveals it), then each row lands on a
 * beat: the snapshot settles with a slight y+scale ease while its copy
 * rises staggered beside it. Hover never moves a frame — only a
 * restrained shadow/keyline shift (CSS). Reduced motion: everything
 * visible instantly, no tweens ever.
 */
import '../styles/showcase.css';
import { gsap } from 'gsap';
import { pad2 } from '../engine/themes';
import {
  isPageBlock,
  resolvePageCardEntry,
  type InlineItem,
  type PageBlock,
  type PageCard,
} from '../engine/data';
import { resolveImage } from '../engine/assets';
import { pageHref } from '../engine/pageCard';
import { mountRepoCard } from '../engine/repoCard';
import { createShotFrame, frameImage, paintShotFrame, type ShotFrame } from '../engine/shotFrame';
import { pageLink, type SectionBuilder } from './types';

/* Real captures that MAY exist — resolved at build time; when a file is
   absent the glob simply has no entry and the illustrative frame renders
   instead. Drop architecture.webp / dashboard.webp into src/assets and
   rebuild to upgrade those rows to real screenshots. */
const OPTIONAL_SHOTS = import.meta.glob<string>('../assets/{architecture,dashboard}.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});
const ARCH_SHOT = OPTIONAL_SHOTS['../assets/architecture.webp'];
const DASH_SHOT = OPTIONAL_SHOTS['../assets/dashboard.webp'];

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

/* ------------------------------------------------------------ snapshots */

/* The frame itself lives in engine/shotFrame.ts — the reading room's hero
   shot and the markdown '!image[…]' figure wear the same one. This file
   only decides WHAT goes in it. */
interface Snapshot {
  /** Mono address label in the frame's chrome bar. */
  addr: string;
  /** One honest mono line under the frame. */
  caption: string;
  /** The frame body: an <img> capture or an illustrative mock. */
  body: HTMLElement;
}

/** A real capture: dimensions declared for layout stability, lazy. */
const shotImg = frameImage;

/** Illustrative mock container — role=img so the label speaks for all
    the presentational shapes inside. */
function mock(cls: string, label: string): HTMLDivElement {
  const m = el('div', 'sc-mock ' + cls);
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', label);
  return m;
}

/** Tiered nodes + wires — the platform sketched, clearly a diagram.
    Static shapes, built node by node via createElementNS (no HTML strings). */
function archMock(): HTMLElement {
  const m = mock(
    'sc-arch-wrap',
    'Illustrative architecture diagram: a load balancer above three service nodes, wired down to a Postgres database and an event bus; a dashed chip notes the nightly scale-to-zero.',
  );
  const svg = svgEl('svg', {
    class: 'sc-arch',
    viewBox: '0 0 640 400',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  /* wires: alb → services, then services → data tier */
  const wires: Array<[cls: string, d: string]> = [
    ['sc-w', 'M320 92 C320 124 130 118 130 150'],
    ['sc-w', 'M320 92 L320 150'],
    ['sc-w', 'M320 92 C320 124 510 118 510 150'],
    ['sc-w', 'M130 214 C130 252 150 256 150 286'],
    ['sc-w', 'M320 214 C320 254 216 262 198 288'],
    ['sc-w sc-w--evt', 'M130 214 C130 264 370 252 370 306'],
    ['sc-w sc-w--evt', 'M510 214 C510 254 490 266 490 306'],
  ];
  for (const [cls, d] of wires) svg.appendChild(svgEl('path', { class: cls, d }));
  /* load balancer */
  svg.appendChild(
    svgEl('rect', { class: 'sc-node sc-node--alb', x: '230', y: '52', width: '180', height: '40', rx: '8' }),
  );
  svg.appendChild(svgEl('text', { class: 'sc-lbl', x: '320', y: '77' }, 'alb'));
  /* services */
  for (const x of ['55', '245', '435']) {
    svg.appendChild(svgEl('rect', { class: 'sc-node', x, y: '150', width: '150', height: '64', rx: '8' }));
  }
  for (const cx of ['189', '379', '569']) {
    svg.appendChild(svgEl('circle', { class: 'sc-dot-on', cx, cy: '166', r: '4' }));
  }
  const svcLabels: Array<[x: string, label: string]> = [
    ['130', 'api'],
    ['320', 'web'],
    ['510', 'jobs'],
  ];
  for (const [x, label] of svcLabels) {
    svg.appendChild(svgEl('text', { class: 'sc-lbl', x, y: '187' }, label));
  }
  /* data tier: rds cylinder + event bus */
  svg.appendChild(
    svgEl('path', { class: 'sc-node sc-node--data', d: 'M110 296 v52 a60 12 0 0 0 120 0 v-52' }),
  );
  svg.appendChild(
    svgEl('ellipse', { class: 'sc-node sc-node--data', cx: '170', cy: '296', rx: '60', ry: '12' }),
  );
  svg.appendChild(svgEl('text', { class: 'sc-lbl', x: '170', y: '336' }, 'rds'));
  svg.appendChild(
    svgEl('rect', { class: 'sc-node sc-node--data', x: '330', y: '306', width: '250', height: '40', rx: '20' }),
  );
  svg.appendChild(svgEl('text', { class: 'sc-lbl', x: '455', y: '331' }, 'events'));
  /* the honest footnote of this platform: lights out at night */
  svg.appendChild(svgEl('rect', { class: 'sc-chip', x: '462', y: '42', width: '146', height: '30', rx: '15' }));
  svg.appendChild(svgEl('text', { class: 'sc-lbl sc-lbl--chip', x: '535', y: '61' }, 'nightly: scale → 0'));
  m.appendChild(svg);
  return m;
}

/** Service cards with status lights and power pills over scheduling
    rules — the control panel's idiom in abstract blocks. */
function panelMock(): HTMLElement {
  const m = mock(
    'sc-cp',
    'Illustrative ops panel: three service cards with status lights and power toggles, above a table of scheduling rules with switches.',
  );
  const cards = el('div', 'sc-cp-cards');
  const names = ['api', 'web', 'jobs'];
  names.forEach((name, i) => {
    const off = i === 2; /* one service powered down — the panel's point */
    const card = el('div', 'sc-cp-card' + (off ? ' is-off' : ''));
    const head = el('div', 'sc-cp-head');
    head.appendChild(el('i', 'sc-cp-dot'));
    head.appendChild(el('span', 'sc-cp-name', name));
    card.appendChild(head);
    card.appendChild(el('i', 'sc-bar sc-bar--l'));
    card.appendChild(el('i', 'sc-bar sc-bar--s'));
    const pill = el('span', 'sc-cp-pill');
    pill.appendChild(el('i', null));
    card.appendChild(pill);
    cards.appendChild(card);
  });
  m.appendChild(cards);
  const rules = el('div', 'sc-cp-rules');
  for (let i = 0; i < 3; i++) {
    const row = el('div', 'sc-cp-rule');
    row.appendChild(el('i', 'sc-bar sc-bar--l'));
    row.appendChild(el('i', 'sc-bar sc-bar--s'));
    row.appendChild(el('span', 'sc-cp-switch' + (i < 2 ? ' is-on' : '')));
    rules.appendChild(row);
  }
  m.appendChild(rules);
  return m;
}

/** Product grid, cart chip, checkout bar — a storefront in abstract
    shapes only; no fake brand, no fake copy. */
function shopMock(): HTMLElement {
  const m = mock(
    'sc-shop',
    'Illustrative storefront: a product grid, a cart chip with three items, and a checkout bar — drawn as abstract blocks.',
  );
  const top = el('div', 'sc-shop-top');
  top.appendChild(el('i', 'sc-shop-logo'));
  const nav = el('span', 'sc-shop-nav');
  for (let i = 0; i < 3; i++) nav.appendChild(el('i', 'sc-bar sc-bar--nav'));
  top.appendChild(nav);
  const cart = el('span', 'sc-shop-cart');
  cart.appendChild(el('b', null, '3'));
  top.appendChild(cart);
  m.appendChild(top);
  const grid = el('div', 'sc-shop-grid');
  for (let i = 0; i < 6; i++) {
    const tile = el('div', 'sc-shop-tile');
    tile.appendChild(el('i', 'sc-shop-ph' + (i % 3 === 1 ? ' is-alt' : '')));
    tile.appendChild(el('i', 'sc-bar sc-bar--l'));
    tile.appendChild(el('i', 'sc-bar sc-bar--s'));
    grid.appendChild(tile);
  }
  m.appendChild(grid);
  const co = el('div', 'sc-shop-co');
  for (let i = 0; i < 3; i++) co.appendChild(el('i', 'sc-shop-step' + (i < 2 ? ' is-done' : '')));
  co.appendChild(el('i', 'sc-shop-pay'));
  m.appendChild(co);
  return m;
}

/** The neutral fallback: a page sketched as a rule, a title and prose. */
function docMock(): HTMLElement {
  const m = mock('sc-doc', 'Illustrative page sketch: a rule, a title block and lines of prose.');
  const head = el('div', 'sc-doc-head');
  head.appendChild(el('i', 'sc-doc-rule'));
  head.appendChild(el('i', 'sc-doc-title'));
  m.appendChild(head);
  const lines = el('div', 'sc-doc-lines');
  for (let i = 0; i < 5; i++) {
    lines.appendChild(el('i', 'sc-bar' + (i % 3 === 2 ? ' sc-bar--s' : ' sc-bar--l')));
  }
  m.appendChild(lines);
  return m;
}

/**
 * The per-slug stylized frame — the fallback visual a row wears until (or
 * unless) its page declares an image of its own. Real captures win where
 * they exist; sketches declare themselves sketches in the caption.
 */
function fallbackSnapshot(key: string): Snapshot {
  if (key.includes('eleva-platform') || key.includes('eleva platform')) {
    if (ARCH_SHOT) {
      return {
        addr: 'ops panel — architecture',
        caption: 'architecture rendered live from the deployed CloudFormation',
        body: shotImg(
          ARCH_SHOT,
          'The live architecture view of the Eleva platform, rendered from the deployed CloudFormation template.',
          1500,
          950,
        ),
      };
    }
    return {
      /* generic label — a mock must not claim a URL it never rendered */
      addr: 'platform architecture — sketch',
      caption: 'illustrative sketch of the platform tiers — not a screenshot',
      body: archMock(),
    };
  }
  if (key.includes('control-panel') || key.includes('control panel')) {
    if (DASH_SHOT) {
      return {
        addr: 'ops panel',
        caption: 'the control panel dashboard, captured from the live deployment',
        body: shotImg(
          DASH_SHOT,
          'The infra control panel dashboard: service cards with status and power controls.',
          1500,
          950,
        ),
      };
    }
    return {
      /* generic label — a mock must not claim a URL it never rendered */
      addr: 'ops panel — sketch',
      caption: 'illustrative sketch of the panel idiom — not a screenshot',
      body: panelMock(),
    };
  }
  if (key.includes('commerce') || key.includes('replatform')) {
    return {
      addr: 'storefront — magento 2 · hyvä',
      caption: 'illustrative storefront blocks — the real shop keeps its own brand',
      body: shopMock(),
    };
  }
  if (key.includes('this-site') || key.includes('this site')) {
    const shot = resolveImage('asset:maintainer');
    if (shot) {
      return {
        addr: 'this site — /#/maintain',
        caption: shot.caption ?? 'the maintainer console of this site',
        body: shotImg(shot.url, shot.alt, shot.width, shot.height),
      };
    }
  }
  return {
    addr: 'page — sketch',
    caption: 'illustrative page sketch — not a screenshot',
    body: docMock(),
  };
}

/**
 * The frame a RESOLVED page earns: its own image, when it declares one.
 * The address bar then reads the page's own route — the frame is showing
 * that page's picture, and a caption says what the picture is. A sketch
 * address ('… — sketch') never sits over a real image.
 */
function snapshotForCard(slug: string, card: PageCard): Snapshot | null {
  const img = resolveImage(card.image);
  if (!img) return null;
  return {
    addr: pageHref(slug),
    caption: img.caption ?? 'the image this page carries',
    body: shotImg(img.url, img.alt || '', img.width, img.height),
  };
}

/* -------------------------------------------------------------- builder */

interface Row {
  root: HTMLElement;
  /** The shared browser frame (engine/shotFrame.ts) — figure and slots. */
  shot: ShotFrame;
  /** The copy COLUMN: the copy card, plus anything that must not nest
      inside it — the repo widget is its own link, so it lives here. */
  side: HTMLElement;
  num: HTMLElement;
  copyEls: HTMLElement[];
}

export const buildShowcase: SectionBuilder = (host, section, _index, ctx) => {
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-sc');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kick = el('p', 'sc-kicker', section.kicker);
  const headline = el('h2', 'sc-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const sum = el('p', 'sc-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kick, headline, sum, plink);
  col.appendChild(head);

  const rows: Row[] = [];
  const list = el('div', 'sc-list');

  /** Sides alternate and case-study numbers count VISIBLE rows only, so a
      collapsed (unpublished) row leaves no gap in the rhythm. */
  function reindex(): void {
    rows.forEach((r, i) => {
      r.root.classList.toggle('sc-row--flip', i % 2 === 1);
      r.num.textContent = 'CS ' + pad2(i + 1);
    });
  }

  /** The shared row shell: frame on one side, copy container on the other. */
  function addRow(copy: HTMLElement): Row {
    const root = el('article', 'sc-row');
    const shot = createShotFrame(undefined, 'sc-shot');
    root.appendChild(shot.figure);
    const side = el('div', 'sc-side');
    side.appendChild(copy);
    root.appendChild(side);
    list.appendChild(root);
    const num = el('p', 'sc-num');
    copy.prepend(num);
    const row: Row = { root, shot, side, num, copyEls: [] };
    rows.push(row);
    return row;
  }

  /** Paint a frame's body/address/caption — the only place that swaps art. */
  function paintFrame(row: Row, snap: Snapshot): void {
    paintShotFrame(row.shot, snap);
  }

  /* ------------------------------- inline items ------------------------ */

  function buildInlineRow(item: InlineItem): void {
    const copy = el('div', 'sc-copy');
    const row = addRow(copy);
    paintFrame(row, fallbackSnapshot(item.title.toLowerCase()));
    const title = el('h3', 'sc-title', item.title);
    const deck = el('p', 'sc-deck', item.deck);
    const tags = el('p', 'sc-tags');
    for (const tg of item.tags ?? []) tags.appendChild(el('span', null, tg));
    copy.append(title, deck, tags);
    row.copyEls = [row.num, title, deck, tags];
  }

  /* -------------------------------- page blocks ------------------------ */

  function buildBlockRow(block: PageBlock): void {
    const slug = block.page;
    /* the whole copy card is ONE anchor — one tab stop, one focus ring,
       nothing interactive nested inside it */
    const copy = el('a', 'sc-copy sc-copy--link is-loading');
    copy.href = pageHref(slug);
    const row = addRow(copy);
    paintFrame(row, fallbackSnapshot(slug));

    const title = el('h3', 'sc-title');
    const deck = el('p', 'sc-deck');
    const tags = el('p', 'sc-tags');
    for (const tg of block.tags ?? []) tags.appendChild(el('span', null, tg));
    const cta = el('p', 'sc-cta', 'Read the case study');
    const arrow = el('span', 'sc-cta-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    cta.appendChild(arrow);
    copy.append(title, deck, tags, cta);
    /* the repo widget is a link of its own — it sits BESIDE the copy card,
       never inside it (one anchor per link, never a nested tab stop). The
       slot is created now, empty and hidden, so it takes part in the row's
       entrance instead of popping in at full opacity when the page lands. */
    const repoSlot = el('div', 'sc-repo');
    repoSlot.hidden = true;
    row.side.appendChild(repoSlot);
    row.copyEls = [row.num, title, deck, tags, cta, repoSlot];

    /* the placeholder is a skeleton, not a lie: no invented title, no
       invented deck — just the shape of the copy while it loads */
    title.appendChild(el('span', 'sc-skel sc-skel--title'));
    deck.appendChild(el('span', 'sc-skel'));
    deck.appendChild(el('span', 'sc-skel sc-skel--short'));

    void resolvePageCardEntry(slug).then((res) => {
      if (res.state === 'hidden') {
        /* the LIVE API said draft/unpublished/unknown, or the slug exists
           nowhere at all — only then does the row collapse. A silent API
           never reaches this branch: it resolves from the snapshot. */
        const at = rows.indexOf(row);
        if (at >= 0) rows.splice(at, 1);
        row.root.remove();
        reindex();
        return;
      }
      const card = res.card;
      copy.classList.remove('is-loading');
      title.textContent = card.title;
      deck.textContent = card.summary;
      const own = snapshotForCard(slug, card);
      if (own) paintFrame(row, own);
      /* a page that names its repository shows it under the copy — the
         widget resolves on its own beat and never holds up the row */
      if (card.repo) {
        repoSlot.hidden = false;
        repoSlot.appendChild(mountRepoCard(card.repo));
      }
    });
  }

  for (const item of section.items) {
    if (isPageBlock(item)) buildBlockRow(item);
    else buildInlineRow(item);
  }
  reindex();
  col.appendChild(list);
  host.appendChild(wrap);

  /* ---------------------------- entrance -------------------------------- */

  const headRise: HTMLElement[] = [kick, sum, plink]; /* headline is the morph's */
  /** Recomputed on demand — rows disappear when their page is unpublished. */
  const everything = (): HTMLElement[] => [
    ...headRise,
    ...rows.flatMap((r) => [r.shot.figure, ...r.copyEls]),
  ];
  let tl: gsap.core.Timeline | null = null;

  function killEntrance(): void {
    if (tl) {
      tl.kill();
      tl = null;
    }
    gsap.killTweensOf(everything());
  }

  /** Settle instantly — reduced-motion flip or teardown safety. */
  function showInstant(): void {
    killEntrance();
    gsap.set(everything(), { clearProps: 'opacity,visibility,transform' });
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
      for (const r of rows) {
        gsap.set(r.shot.figure, { opacity: 0, y: 28, scale: 0.965, transformOrigin: '50% 62%' });
        gsap.set(r.copyEls, { opacity: 0, y: 22 });
      }
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        showInstant();
        return;
      }
      tl = gsap.timeline();
      /* the head rises first... */
      tl.to(
        headRise,
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.09, ease: 'power2.out', clearProps: 'opacity,transform' },
        0,
      );
      /* ...then each case-study row lands on its own beat: the snapshot
         settles (y + scale) while its copy rises staggered beside it */
      rows.forEach((r, i) => {
        const at = 0.24 + i * 0.16;
        tl!.to(
          r.shot.figure,
          { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: 'power3.out', clearProps: 'opacity,transform' },
          at,
        );
        tl!.to(
          r.copyEls,
          { opacity: 1, y: 0, duration: 0.55, stagger: 0.07, ease: 'power2.out', clearProps: 'opacity,transform' },
          at + 0.1,
        );
      });
    },
    destroy() {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      killEntrance();
    },
  };
};

export default buildShowcase;
