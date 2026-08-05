/**
 * REPO CARD — one component, drawn once, worn by every finish.
 *
 * The GitHub widget: a repo mark, owner/name (the name carries the
 * emphasis), the description, and a meta row of language, stars, forks and
 * 'updated <relative>'. It reads its color from `currentColor` and the
 * surrounding finish's scoped tokens (--accent, --focus, --font-*) exactly
 * like engine/pageCard.ts, so it belongs to the Swiss showcase band, the
 * Seafoam reading room and the Event Log preview pane alike. There is no
 * GitHub palette here — the ONE literal color a repo card may draw is the
 * language dot, and that is data (see LANGUAGE_COLORS).
 *
 * THREE STATES, all first class (engine/data.ts's resolveRepo):
 *   public      — the whole card is one <a> to the repository, new tab;
 *   private     — NOT a link. A private repo answers 404 to a signed-out
 *                 visitor, so a link would be a dead end: the card renders
 *                 the same shell with a quiet 'Private repository' chip and
 *                 no href at all. This is Diego's infra repo's real state,
 *                 not an error;
 *   unavailable — the proxy learned nothing this time (rate limit, timeout,
 *                 network). Same shell, a muted note, and it still links
 *                 out: the repository may well be there, we just cannot say
 *                 anything about it.
 *
 * A skeleton stands in while the fetch is out; nothing here ever blocks the
 * surrounding render. Every string from the API lands via textContent and
 * the glyphs are built with createElementNS — no innerHTML anywhere.
 *
 * Markdown embeds arrive here too: renderMarkdown() emits inert
 * '.pg-blocks > .pg-block[data-repo]' placeholders alongside the page-block
 * slots it already emitted (ONE grouping path, one grid), and
 * hydrateRepoBlocks() fills them in after the fragment is in the DOM.
 */
import '../styles/repoCard.css';
import { isRepoRef, resolveRepo, type RepoInfo, type RepoUnavailableReason } from './data';
import { BLOCK_GRID_CLASS, BLOCK_SLOT_CLASS } from './pageCard';

export interface RepoCardOptions {
  /** Extra class for the mount, e.g. a placement modifier. */
  className?: string;
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** createElementNS + attributes — no HTML strings, ever. */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function icon(cls: string): SVGSVGElement {
  return svgEl('svg', {
    class: cls,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false',
  });
}

/** The repo mark: a book — rounded spine, page line — stroked in
    currentColor. Deliberately not the octocat: the widget wears the finish
    it sits in and borrows no brand. */
function repoMark(): SVGSVGElement {
  const svg = icon('rc-mark');
  const attrs = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  /* cover: rounded left corners, straight fore-edge; the closing line IS
     the spine */
  svg.appendChild(
    svgEl('path', { ...attrs, d: 'M3.25 3.5A1.5 1.5 0 0 1 4.75 2H13v12H4.75A1.5 1.5 0 0 1 3.25 12.5Z' }),
  );
  /* the page block inside it */
  svg.appendChild(svgEl('path', { ...attrs, d: 'M3.25 11.5H13' }));
  return svg;
}

/** A filled star — the count beside it says what it counts. */
function starMark(): SVGSVGElement {
  const svg = icon('rc-ico');
  svg.appendChild(
    svgEl('path', {
      fill: 'currentColor',
      d: 'M8 1.9l1.82 3.69 4.07.59-2.95 2.87.7 4.05L8 11.19l-3.64 1.91.7-4.05L2.11 6.18l4.07-.59z',
    }),
  );
  return svg;
}

/** A fork: two heads over a trunk. */
function forkMark(): SVGSVGElement {
  const svg = icon('rc-ico');
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  svg.appendChild(svgEl('circle', { ...stroke, cx: '4.4', cy: '3.4', r: '1.7' }));
  svg.appendChild(svgEl('circle', { ...stroke, cx: '11.6', cy: '3.4', r: '1.7' }));
  svg.appendChild(svgEl('circle', { ...stroke, cx: '8', cy: '12.6', r: '1.7' }));
  svg.appendChild(svgEl('path', { ...stroke, d: 'M4.4 5.1v1.5a2 2 0 0 0 2 2h3.2a2 2 0 0 0 2-2V5.1' }));
  svg.appendChild(svgEl('path', { ...stroke, d: 'M8 8.6v2.3' }));
  return svg;
}

/** A closed padlock — the private chip's quiet punctuation. */
function lockMark(): SVGSVGElement {
  const svg = icon('rc-ico rc-ico--lock');
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  svg.appendChild(svgEl('rect', { ...stroke, x: '3.2', y: '7', width: '9.6', height: '6.6', rx: '1.4' }));
  svg.appendChild(svgEl('path', { ...stroke, d: 'M5.6 7V5.1a2.4 2.4 0 0 1 4.8 0V7' }));
  return svg;
}

/* ------------------------------------------------------- language colors
   DATA, NOT THEME. These are the canonical per-language colors GitHub's
   linguist ships, and a reader recognises them the way they recognise a
   flag: a yellow dot IS JavaScript. They are literal values on purpose,
   they are the only literal colors in this component, and they are applied
   to NOTHING but the 6px language dot — every other surface, rule and
   letterform still comes from the surrounding finish's tokens. A language
   we do not know draws the dot in muted currentColor instead. */
const LANGUAGE_COLORS: Record<string, string> = {
  c: '#555555',
  'c#': '#178600',
  'c++': '#f34b7d',
  css: '#563d7c',
  dart: '#00b4ab',
  dockerfile: '#384d54',
  elixir: '#6e4a7e',
  go: '#00add8',
  hcl: '#844fba',
  haskell: '#5e5086',
  html: '#e34c26',
  java: '#b07219',
  javascript: '#f1e05a',
  kotlin: '#a97bff',
  lua: '#000080',
  makefile: '#427819',
  nix: '#7e7eff',
  'objective-c': '#438eff',
  php: '#4f5d95',
  perl: '#0298c3',
  python: '#3572a5',
  r: '#198ce7',
  ruby: '#701516',
  rust: '#dea584',
  scala: '#c22d40',
  scss: '#c6538c',
  shell: '#89e051',
  sql: '#e38c00',
  svelte: '#ff3e00',
  swift: '#f05138',
  typescript: '#3178c6',
  vue: '#41b883',
  zig: '#ec915c',
};

/* --------------------------------------------------------------- pieces */

const RELATIVE_UNITS: Array<[limit: number, unit: Intl.RelativeTimeFormatUnit, per: number]> = [
  [60, 'second', 1],
  [3600, 'minute', 60],
  [86400, 'hour', 3600],
  [604800, 'day', 86400],
  [2629800, 'week', 604800],
  [31557600, 'month', 2629800],
  [Infinity, 'year', 31557600],
];

/** Built once, and only if the browser has it — no Intl, no chip. */
let RTF: Intl.RelativeTimeFormat | null | undefined;
function relativeFormatter(): Intl.RelativeTimeFormat | null {
  if (RTF === undefined) {
    try {
      RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    } catch {
      RTF = null;
    }
  }
  return RTF;
}

/**
 * 'updated 3 days ago' — the arithmetic is ours, the phrasing is Intl's.
 * null for an unparseable (or absent) timestamp: the meta row simply drops
 * the chip rather than printing 'Invalid Date' at an employer.
 */
export function relativeTime(iso: string, now: number = Date.now()): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const fmt = relativeFormatter();
  if (fmt === null) return null;
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const row = RELATIVE_UNITS.find(([limit]) => abs < limit) ?? RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return fmt.format(Math.round(seconds / row[2]), row[1]);
}

/** owner/name, with the NAME carrying the weight. */
function nameLine(fullName: string): HTMLElement {
  const wrap = el('span', 'rc-name');
  const cut = fullName.indexOf('/');
  if (cut > 0) {
    wrap.appendChild(el('span', 'rc-owner', fullName.slice(0, cut)));
    wrap.appendChild(el('span', 'rc-sep', '/'));
    wrap.appendChild(el('span', 'rc-title', fullName.slice(cut + 1)));
  } else {
    wrap.appendChild(el('span', 'rc-title', fullName));
  }
  return wrap;
}

/** A figure with its glyph and a screen-reader label for what it counts. */
function stat(glyph: SVGSVGElement, value: number, label: string): HTMLElement {
  const s = el('span', 'rc-stat');
  s.appendChild(glyph);
  s.appendChild(el('span', 'rc-num', value.toLocaleString()));
  s.appendChild(el('span', 'rc-sr', ' ' + label));
  return s;
}

/** The language dot + its name. The dot is the only literal color here. */
function languageRow(language: string): HTMLElement {
  const wrap = el('span', 'rc-stat rc-lang');
  const dot = el('i', 'rc-dot');
  const known = LANGUAGE_COLORS[language.trim().toLowerCase()];
  /* the VALUE is ours, from the table above — never the API's string */
  if (known) dot.style.setProperty('--rc-lang', known);
  dot.setAttribute('aria-hidden', 'true');
  wrap.appendChild(dot);
  wrap.appendChild(el('span', null, language));
  return wrap;
}

const UNAVAILABLE_NOTE: Record<RepoUnavailableReason, string> = {
  'rate-limited': 'GitHub rate limit reached — details return shortly',
  timeout: 'GitHub did not answer in time — details return shortly',
  error: 'repository details are unavailable right now',
};

/* ---------------------------------------------------------- the widget */

/** The shell every state shares: the mark and owner/name. Returns the head
    row so a state can hang its own chip off it. */
function shell(card: HTMLElement, fullName: string): HTMLElement {
  const head = el('span', 'rc-head');
  head.appendChild(repoMark());
  head.appendChild(nameLine(fullName));
  card.appendChild(head);
  return head;
}

/**
 * The card, in whichever state the proxy reported. Public and unavailable
 * are anchors (new tab, noopener); private is a plain element with no href
 * — a signed-out visitor would only meet a 404.
 */
export function createRepoCard(info: RepoInfo): HTMLElement {
  if (info.state === 'private') {
    const card = el('div', 'rc-card rc-card--private');
    const head = shell(card, info.fullName);
    const chip = el('span', 'rc-chip');
    chip.appendChild(lockMark());
    chip.appendChild(el('span', null, 'Private repository'));
    head.appendChild(chip); /* the head wraps: a long name never squeezes it */
    /* the note explains the ONE thing this card does differently */
    card.appendChild(el('span', 'rc-note', 'no link — a signed-out visitor would only meet a 404'));
    return card;
  }

  const card = el('a', 'rc-card');
  card.href = info.url; /* derived or github.com-verified in data.ts */
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  shell(card, info.fullName);

  if (info.state === 'unavailable') {
    card.appendChild(el('span', 'rc-note', UNAVAILABLE_NOTE[info.reason]));
    return card;
  }

  const description = info.description?.trim() ?? '';
  if (description) card.appendChild(el('span', 'rc-desc', description));

  const meta = el('span', 'rc-meta');
  if (info.language) meta.appendChild(languageRow(info.language));
  meta.appendChild(stat(starMark(), info.stars, info.stars === 1 ? 'star' : 'stars'));
  meta.appendChild(stat(forkMark(), info.forks, info.forks === 1 ? 'fork' : 'forks'));
  const rel = relativeTime(info.pushedAt);
  if (rel) {
    const upd = el('time', 'rc-upd', 'updated ' + rel);
    upd.dateTime = info.pushedAt;
    meta.appendChild(upd);
  }
  if (meta.childElementCount) card.appendChild(meta);

  const topics = info.topics.slice(0, 4);
  if (topics.length) {
    const row = el('span', 'rc-topics');
    for (const t of topics) row.appendChild(el('span', 'rc-topic', t));
    card.appendChild(row);
  }
  return card;
}

/** The shape of the card while the fetch is out — never invented copy. */
export function createRepoSkeleton(ref: string): HTMLElement {
  const card = el('div', 'rc-card rc-card--skeleton');
  card.setAttribute('aria-busy', 'true');
  shell(card, ref);
  card.appendChild(el('span', 'rc-skel rc-skel--desc'));
  card.appendChild(el('span', 'rc-skel rc-skel--meta'));
  return card;
}

/**
 * Mount point for the direct placements (showcase row, page room): returns
 * an element to append NOW, carrying a skeleton, that swaps itself for the
 * resolved card. A reference that is not 'owner/name' leaves an empty,
 * hidden mount — nothing renders, nothing is requested.
 */
export function mountRepoCard(ownerRepo: string, opts: RepoCardOptions = {}): HTMLElement {
  const host = el('div', 'rc-mount' + (opts.className ? ' ' + opts.className : ''));
  const ref = ownerRepo.trim();
  if (!isRepoRef(ref)) {
    host.hidden = true;
    return host;
  }
  host.appendChild(createRepoSkeleton(ref));
  void resolveRepo(ref).then((info) => {
    host.textContent = '';
    if (info === null) {
      host.hidden = true;
      return;
    }
    host.appendChild(createRepoCard(info));
  });
  return host;
}

/* ------------------------------------------------------ markdown blocks */

/**
 * Fill every '!repo[owner/name]' placeholder under `root` — the repo half
 * of the SAME grid renderMarkdown() builds for '!page[slug]' runs.
 * Idempotent (a slot is marked the moment it is claimed), silent (a
 * malformed reference just removes the slot) and non-blocking.
 */
export function hydrateRepoBlocks(root: ParentNode): Promise<void> {
  const slots = root.querySelectorAll<HTMLElement>(
    '.' + BLOCK_SLOT_CLASS + '[data-repo]:not([data-rc-state])',
  );
  const jobs: Promise<void>[] = [];

  /** A grid whose every block vanished leaves no gap behind. */
  const prune = (grid: Element | null): void => {
    if (grid && grid.classList.contains(BLOCK_GRID_CLASS) && grid.childElementCount === 0) {
      grid.remove();
    }
  };

  for (const slot of slots) {
    const ref = (slot.dataset.repo ?? '').trim();
    slot.dataset.rcState = 'loading';
    if (!isRepoRef(ref)) {
      const grid = slot.parentElement;
      slot.remove();
      prune(grid);
      continue;
    }
    slot.appendChild(createRepoSkeleton(ref));
    const job = resolveRepo(ref).then((info) => {
      const grid = slot.parentElement;
      slot.textContent = '';
      if (info === null) {
        slot.remove();
        prune(grid);
        return;
      }
      slot.dataset.rcState = 'ready';
      slot.appendChild(createRepoCard(info));
    });
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
}

export default createRepoCard;
