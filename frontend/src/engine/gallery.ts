/**
 * GALLERY — the picture strip and the lightbox behind it.
 *
 * A page's `gallery` is an array of { ref, caption? }: `ref` is exactly
 * what `image` accepts (an 'https://…' URL or an 'asset:<token>'), and the
 * caption is the PAGE's words about that shot, so it travels with the
 * reference rather than being looked up from the asset.
 *
 * WHAT THIS DRAWS
 *   - a responsive grid of thumbnails (auto-fit, ~230px minimum, one
 *     column under 560px) in aspect-ratio boxes, so nothing shifts while
 *     the pictures decode; lazy, async, captions under the tiles;
 *   - framed figures for the markdown '!image[…]' block — the SAME
 *     browser-chrome frame the showcase uses (engine/shotFrame.ts), never
 *     a second implementation of it;
 *   - the LIGHTBOX every tile opens: a body-level aria-modal dialog above
 *     the reading room, the shot contained and centered, caption and an
 *     'n / total' counter, previous/next, ArrowLeft/ArrowRight/Home/End/
 *     Escape, focus trapped while open and restored to the originating
 *     tile on close, background scroll held by the ref-counted
 *     engine/overlayLock.ts (the room below keeps its own lock — this one
 *     stacks on top and hands it back).
 *
 * The grid and the tiles are finish-agnostic (currentColor + --accent +
 * --font-*, like engine/pageCard.ts). The lightbox is a room of its own —
 * a neutral scrim, no palette — and inherits the originating band's
 * scoped tokens so its accent, focus ring and mono face still belong to
 * the finish the reader came from.
 *
 * Motion is GSAP and short; under prefers-reduced-motion the lightbox
 * simply appears. No picture is ever draggable: a drag ghost over a
 * lightbox trigger is pure jank.
 */
import '../styles/gallery.css';
import { gsap } from 'gsap';
import { resolveImage } from './assets';
import { lockScroll, unlockScroll } from './overlayLock';
import { createShotFrame, frameImage } from './shotFrame';

/** One picture in a gallery — the API's shape, mirrored. */
export interface GalleryEntry {
  ref: string;
  /** Absent, never empty, when the shot speaks for itself. */
  caption?: string;
}

/** A gallery is a strip, not an archive — the API's cap, mirrored. */
export const GALLERY_MAX_ENTRIES = 24;

/** A resolved, drawable picture. */
export interface Shot {
  url: string;
  alt: string;
  width: number;
  height: number;
  /** The page's caption for this shot, if it wrote one. */
  caption?: string;
  /** The mono label a frame wears: the asset token, or the URL's host+path. */
  label: string;
}

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

/* ------------------------------------------------------------- parsing */

function parseEntry(item: string): GalleryEntry | null {
  const bar = item.indexOf('|');
  const ref = (bar < 0 ? item : item.slice(0, bar)).trim();
  if (ref === '') return null; /* a caption with no picture is not an entry */
  const caption = bar < 0 ? '' : item.slice(bar + 1).trim();
  return caption ? { ref, caption } : { ref };
}

/** What an entry starts with, and therefore where a comma really splits. */
const REF_START = /^(?:asset:|https:\/\/)/;

/**
 * 'asset:a|Caption, asset:b' → entries. The comma-separated form the front
 * matter and the '!gallery[…]' block both use — and they read it the SAME
 * way (app/src/pages/front-matter.ts's parseGalleryList is this rule):
 * a comma only starts a new entry when what follows it OPENS a reference
 * ('asset:' or 'https://'). Otherwise it belongs to the caption being
 * written, so 'asset:x|Live docs, generated from the modules' stays one
 * picture with its whole sentence rather than becoming a picture and a
 * broken reference.
 */
export function parseGalleryList(src: string): GalleryEntry[] {
  const items: string[] = [];
  for (const chunk of src.split(',')) {
    const open = items.length > 0 ? items[items.length - 1] : undefined;
    const continuesCaption =
      open !== undefined && open.includes('|') && !REF_START.test(chunk.trim());
    if (continuesCaption) {
      items[items.length - 1] = open + ',' + chunk;
      continue;
    }
    items.push(chunk);
  }
  return items.map(parseEntry).filter((e): e is GalleryEntry => e !== null);
}

/** One entry per line — the maintainer console's textarea form. */
export function parseGalleryLines(src: string): GalleryEntry[] {
  return src
    .split('\n')
    .map(parseEntry)
    .filter((e): e is GalleryEntry => e !== null);
}

/** …and back again, one per line, for loading that textarea. */
export function formatGalleryLines(entries: GalleryEntry[]): string {
  return entries.map((e) => (e.caption ? e.ref + '|' + e.caption : e.ref)).join('\n');
}

/* ------------------------------------------------------------ resolving */

/** Entries → drawable shots. An unresolvable reference is DROPPED: a
    gallery shows the pictures it has, never a broken-image icon. */
export function resolveShots(entries: readonly GalleryEntry[] | undefined | null): Shot[] {
  const out: Shot[] = [];
  for (const entry of entries ?? []) {
    const img = resolveImage(entry.ref);
    if (img === null) continue;
    /* the API's shape is trusted but not assumed — a caption that is not a
       string is no caption, never a thrown render */
    const authored = typeof entry.caption === 'string' ? entry.caption.trim() : '';
    const caption = authored || img.caption;
    out.push({
      url: img.url,
      alt: img.alt,
      width: img.width,
      height: img.height,
      ...(caption ? { caption } : {}),
      label: img.token,
    });
  }
  return out;
}

/* ------------------------------------------------------------- the grid */

export interface GalleryOptions {
  /** The sequence the lightbox pages through — defaults to these shots.
      A reading room passes its whole album so the hero belongs to it. */
  album?: Shot[];
  /** Index of the first of these shots within `album`. */
  offset?: number;
  /** Extra class on the grid. */
  className?: string;
}

/** Wire a control to open the lightbox at `index` of `album`. */
function bindOpener(btn: HTMLElement, album: Shot[], index: number): void {
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.addEventListener('click', () => {
    openLightbox(album, index, btn);
  });
}

/**
 * The thumbnail grid. Returns null when nothing resolved, so a caller can
 * simply not add a section rather than add an empty one.
 */
export function createGalleryGrid(shots: Shot[], opts: GalleryOptions = {}): HTMLElement | null {
  if (shots.length === 0) return null;
  const album = opts.album ?? shots;
  const offset = opts.offset ?? 0;
  const grid = el('div', 'gl-grid' + (opts.className ? ' ' + opts.className : ''));
  shots.forEach((shot, i) => {
    const cell = el('figure', 'gl-cell');
    const btn = el('button', 'gl-tile');
    btn.type = 'button';
    /* the image's alt IS the button's name — no second label to drift */
    const img = el('img', 'gl-thumb');
    img.src = shot.url;
    img.alt = shot.alt;
    /* attributes, not properties: the parser acts on them the moment the
       node lands, whatever the engine reflects */
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.draggable = false;
    if (shot.width && shot.height) {
      img.width = shot.width;
      img.height = shot.height;
    }
    btn.appendChild(img);
    bindOpener(btn, album, offset + i);
    cell.appendChild(btn);
    if (shot.caption) cell.appendChild(el('figcaption', 'gl-cap', shot.caption));
    grid.appendChild(cell);
  });
  return grid;
}

/**
 * One framed figure — the browser chrome around a single shot, its token
 * in the address bar, the page's caption underneath, the whole picture a
 * button into the lightbox.
 */
export function createFramedShot(shot: Shot, album: Shot[], index: number): HTMLElement {
  const btn = el('button', 'sf-open');
  btn.type = 'button';
  btn.appendChild(frameImage(shot.url, shot.alt, shot.width, shot.height));
  const frame = createShotFrame(
    { addr: shot.label, caption: shot.caption, body: btn },
    'sf-shot--live',
  );
  bindOpener(btn, album, index);
  return frame.figure;
}

/* ---------------------------------------------------------- the lightbox
   ONE instance, built on first use and reused: the overlay is the same
   room whichever tile opened it. */

interface Lightbox {
  root: HTMLElement;
  scrim: HTMLElement;
  stage: HTMLElement;
  img: HTMLImageElement;
  caption: HTMLElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
}

let box: Lightbox | null = null;
let album: Shot[] = [];
let at = 0;
let openState = false;
let returnFocusTo: HTMLElement | null = null;
let lockedHost: HTMLElement | null = null;
/** Body-level siblings this overlay hid from assistive tech while open. */
let veiled: HTMLElement[] = [];

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True while the overlay is up — the rooms below let Escape pass to it. */
export function isLightboxOpen(): boolean {
  return openState;
}

/** The inner scroller a room uses, so the lock holds the right element. */
function scrollHostOf(node: Element | null): HTMLElement | null {
  let cur: Element | null = node;
  while (cur !== null && cur !== document.body) {
    if (cur instanceof HTMLElement) {
      const style = getComputedStyle(cur);
      if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight) {
        return cur;
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Wear the finish the reader came from: every custom property set on the
 * origin's ancestors (applyTokens writes them inline on each band) is
 * copied onto the overlay, nearest declaration winning. The scrim itself
 * stays neutral — a lightbox is a dark room, not a band.
 */
function inheritTokens(target: HTMLElement, from: Element | null): void {
  for (let i = target.style.length - 1; i >= 0; i--) {
    const prop = target.style.item(i);
    if (prop.startsWith('--')) target.style.removeProperty(prop);
  }
  let cur: Element | null = from;
  while (cur !== null) {
    if (cur instanceof HTMLElement) {
      for (let i = 0; i < cur.style.length; i++) {
        const prop = cur.style.item(i);
        if (!prop.startsWith('--')) continue;
        if (target.style.getPropertyValue(prop) === '') {
          target.style.setProperty(prop, cur.style.getPropertyValue(prop));
        }
      }
    }
    cur = cur.parentElement;
  }
}

/**
 * A modal dialog is modal for a screen reader too: while the viewer is up
 * every OTHER body-level element (the deck, the reading room it was opened
 * from, the fx canvas) is hidden from the accessibility tree. Only nodes
 * this function hid are revealed again — an element that was already
 * aria-hidden stays exactly as its owner left it.
 */
function veilBackground(overlay: HTMLElement): void {
  for (const node of Array.from(document.body.children)) {
    if (node === overlay || !(node instanceof HTMLElement)) continue;
    if (node.hasAttribute('aria-hidden')) continue;
    node.setAttribute('aria-hidden', 'true');
    veiled.push(node);
  }
}

function unveilBackground(): void {
  for (const node of veiled) node.removeAttribute('aria-hidden');
  veiled = [];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A chevron, built with createElementNS — no HTML strings anywhere. */
function chevron(dir: 'left' | 'right'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'gl-chev');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', dir === 'left' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5');
  svg.appendChild(path);
  return svg;
}

function buildLightbox(): Lightbox {
  const root = el('div', 'gl-lb');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Image viewer');
  root.tabIndex = -1;

  const scrim = el('div', 'gl-lb-scrim');
  scrim.addEventListener('click', closeLightbox);
  root.appendChild(scrim);

  const stage = el('figure', 'gl-lb-stage');
  const img = el('img', 'gl-lb-img');
  img.setAttribute('decoding', 'async');
  img.draggable = false;
  stage.appendChild(img);

  /* caption + counter in ONE polite region: paging announces both, once */
  const meta = el('figcaption', 'gl-lb-meta');
  meta.setAttribute('aria-live', 'polite');
  const caption = el('span', 'gl-lb-cap');
  const count = el('span', 'gl-lb-count');
  meta.appendChild(caption);
  meta.appendChild(count);
  stage.appendChild(meta);
  root.appendChild(stage);

  const prev = el('button', 'gl-lb-nav gl-lb-nav--prev');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Previous image');
  prev.appendChild(chevron('left'));
  prev.addEventListener('click', () => {
    show(at - 1);
  });
  const next = el('button', 'gl-lb-nav gl-lb-nav--next');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next image');
  next.appendChild(chevron('right'));
  next.addEventListener('click', () => {
    show(at + 1);
  });
  const close = el('button', 'gl-lb-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close image viewer');
  close.addEventListener('click', closeLightbox);
  root.append(prev, next, close);

  document.body.appendChild(root);
  return { root, scrim, stage, img, caption, count, prev, next, close };
}

/** Warm the neighbours: paging is then a decode, not a download. */
function preload(index: number): void {
  for (const i of [index - 1, index + 1]) {
    const shot = album[i];
    if (shot) new Image().src = shot.url;
  }
}

function show(index: number): void {
  if (box === null || album.length === 0) return;
  /* clamped, not wrapped: the ends of a strip are ends */
  at = Math.max(0, Math.min(album.length - 1, index));
  const shot = album[at];
  box.img.src = shot.url;
  box.img.alt = shot.alt;
  if (shot.width && shot.height) {
    box.img.width = shot.width;
    box.img.height = shot.height;
  } else {
    box.img.removeAttribute('width');
    box.img.removeAttribute('height');
  }
  box.caption.textContent = shot.caption ?? '';
  box.caption.hidden = !shot.caption;
  box.count.textContent = album.length > 1 ? at + 1 + ' / ' + album.length : '';
  box.count.hidden = album.length <= 1;
  const single = album.length <= 1;
  box.prev.hidden = single;
  box.next.hidden = single;
  box.prev.disabled = at === 0;
  box.next.disabled = at === album.length - 1;
  /* a disabled control cannot hold focus — hand it to the twin */
  if (document.activeElement === box.prev && box.prev.disabled) box.next.focus();
  else if (document.activeElement === box.next && box.next.disabled) box.prev.focus();
  preload(at);
}

/** Tab cycles inside the overlay, both directions, never out of it. */
function trapTab(e: KeyboardEvent): void {
  if (box === null) return;
  const stops = [box.prev, box.next, box.close].filter((b) => !b.hidden && !b.disabled);
  if (stops.length === 0) {
    e.preventDefault();
    box.root.focus();
    return;
  }
  const active = document.activeElement;
  const idx = stops.findIndex((b) => b === active);
  e.preventDefault();
  if (idx < 0) {
    (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    return;
  }
  const nextIdx = (idx + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
  stops[nextIdx].focus();
}

function onKeydown(e: KeyboardEvent): void {
  if (!openState || box === null) return;
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      show(at - 1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      show(at + 1);
      break;
    case 'Home':
      e.preventDefault();
      show(0);
      break;
    case 'End':
      e.preventDefault();
      show(album.length - 1);
      break;
    case 'Tab':
      trapTab(e);
      break;
    default:
      break;
  }
}

/** Open the viewer on `shots[index]`, remembering where to return focus. */
export function openLightbox(shots: Shot[], index: number, origin?: HTMLElement | null): void {
  if (shots.length === 0) return;
  if (box === null) box = buildLightbox();
  album = shots;
  const lb = box;
  if (!openState) {
    openState = true;
    returnFocusTo = origin ?? null;
    inheritTokens(lb.root, origin ?? null);
    lockedHost = scrollHostOf(origin ?? null);
    lockScroll(lockedHost); /* stacks on the room's lock, ref-counted */
    lb.root.hidden = false;
    veilBackground(lb.root);
    document.addEventListener('keydown', onKeydown, true);
  }
  show(index);
  lb.root.focus();
  if (!reducedMotion()) {
    gsap.killTweensOf([lb.scrim, lb.stage]);
    gsap.fromTo(lb.scrim, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power1.out' });
    gsap.fromTo(
      lb.stage,
      { opacity: 0, scale: 0.965, y: 10 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration: 0.3,
        ease: 'power2.out',
        clearProps: 'opacity,transform',
      },
    );
  }
}

/** Close it, release the lock, put focus back on the tile that opened it. */
export function closeLightbox(): void {
  if (!openState || box === null) return;
  openState = false;
  document.removeEventListener('keydown', onKeydown, true);
  gsap.killTweensOf([box.scrim, box.stage]);
  gsap.set([box.scrim, box.stage], { clearProps: 'opacity,transform' });
  box.root.hidden = true;
  box.img.removeAttribute('src'); /* stop a half-loaded decode we cancelled */
  unveilBackground();
  unlockScroll(lockedHost);
  lockedHost = null;
  album = [];
  const target = returnFocusTo;
  returnFocusTo = null;
  if (target && target.isConnected) target.focus();
}

/* ------------------------------------------------------ markdown blocks
   renderMarkdown() emits inert slots — '.gl-mount[data-gallery]' for a
   '!gallery[…]' paragraph and '.gl-figs > .gl-fig[data-image]' for a run
   of '!image[…]' paragraphs — exactly the way it emits '.pg-block' slots
   for page cards and repo widgets. This fills them in once the fragment
   is in the DOM. Resolution is local and synchronous (the registry is
   bundled), so unlike the card hydrators this one needs no promise. */

export function hydrateGalleryBlocks(root: ParentNode): void {
  for (const mount of root.querySelectorAll<HTMLElement>('.gl-mount[data-gallery]:not([data-gl-state])')) {
    mount.dataset.glState = 'ready';
    const shots = resolveShots(parseGalleryList(mount.dataset.gallery ?? ''));
    const grid = createGalleryGrid(shots);
    if (grid === null) {
      mount.remove(); /* nothing resolved — leave no gap behind */
      continue;
    }
    mount.appendChild(grid);
  }

  for (const run of root.querySelectorAll<HTMLElement>('.gl-figs:not([data-gl-state])')) {
    run.dataset.glState = 'ready';
    /* ONE album per run: consecutive !image blocks page into each other */
    const pairs: Array<{ slot: HTMLElement; shot: Shot }> = [];
    for (const slot of run.querySelectorAll<HTMLElement>('.gl-fig[data-image]')) {
      const entry = parseEntry(slot.dataset.image ?? '');
      const shots = entry === null ? [] : resolveShots([entry]);
      if (shots.length === 0) slot.remove(); /* unresolvable — no gap left */
      else pairs.push({ slot, shot: shots[0] });
    }
    const shots = pairs.map((p) => p.shot);
    pairs.forEach((p, i) => {
      p.slot.replaceWith(createFramedShot(p.shot, shots, i));
    });
    if (run.childElementCount === 0) run.remove();
  }
}
