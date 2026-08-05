/**
 * PAGE CARD — one component, drawn once, worn by every finish.
 *
 * A card is the published-page atom: image area, title, summary. It is a
 * SINGLE <a href="#/page/:slug"> — the whole card is the link, so there is
 * exactly one tab stop, one focus ring and no nested interactive element
 * anywhere inside it. It never hardcodes a color: everything is drawn from
 * `currentColor` and the surrounding finish's scoped tokens (--accent,
 * --focus, --font-*), so the same component reads correctly in the Seafoam
 * reading room, the Swiss showcase band, or any finish added later.
 *
 * The image area resolves through engine/assets.ts: 'asset:<token>' maps
 * to a bundled capture, 'https://…' is used directly, anything missing or
 * unresolvable falls back to a quiet monogram in the scoped accent.
 *
 * Markdown embeds arrive here too: renderMarkdown() emits inert
 * '.pg-blocks > .pg-block[data-page-slug]' placeholders (it is pure and
 * synchronous — it cannot fetch), and hydratePageBlocks() fills them in
 * after the fragment is in the DOM. Resolution is async and silent: an
 * unknown or unpublished slug leaves nothing behind.
 */
import '../styles/pageCard.css';
import { monogram, resolveImage } from './assets';
import { resolvePageCard, type PageCard } from './data';

export interface PageCardOptions {
  /** Tag row (page blocks carry their tags in content.json). */
  tags?: string[];
  /** Extra class for the host band, e.g. a grid modifier. */
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

export function pageHref(slug: string): string {
  return '#/page/' + encodeURIComponent(slug);
}

/** The image area — a real picture when one resolves, a monogram if not. */
export function createCardMedia(card: PageCard): HTMLElement {
  const media = el('span', 'pc-media');
  const img = resolveImage(card.image);
  if (img) {
    const node = el('img', 'pc-img');
    node.src = img.url;
    node.alt = img.alt; /* '' → the card's own title speaks for the link */
    if (img.width && img.height) {
      node.width = img.width;
      node.height = img.height;
    }
    node.loading = 'lazy';
    node.decoding = 'async';
    media.appendChild(node);
    return media;
  }
  const ph = el('span', 'pc-mono', monogram(card.title));
  ph.setAttribute('aria-hidden', 'true');
  media.appendChild(ph);
  media.classList.add('is-placeholder');
  return media;
}

/** The whole card, as one anchor. */
export function createPageCard(card: PageCard, opts: PageCardOptions = {}): HTMLAnchorElement {
  const a = el('a', 'pc-card' + (opts.className ? ' ' + opts.className : ''));
  a.href = pageHref(card.slug);
  a.appendChild(createCardMedia(card));

  const body = el('span', 'pc-body');
  body.appendChild(el('span', 'pc-title', card.title));
  if (card.summary) body.appendChild(el('span', 'pc-summary', card.summary));
  const tags = opts.tags ?? [];
  if (tags.length) {
    const row = el('span', 'pc-tags');
    for (const t of tags) row.appendChild(el('span', null, t));
    body.appendChild(row);
  }
  a.appendChild(body);
  return a;
}

/* ------------------------------------------------------ markdown blocks */

/** The class renderMarkdown() stamps on a run of consecutive embeds. */
export const BLOCK_GRID_CLASS = 'pg-blocks';
/**
 * …and on each slot inside it, carrying data-page-slug — or data-repo,
 * for the repo widget, which shares this grid rather than forking it
 * (engine/repoCard.ts's hydrateRepoBlocks claims those).
 */
export const BLOCK_SLOT_CLASS = 'pg-block';

/**
 * Fill every '!page[slug]' placeholder under `root`. Idempotent (a slot is
 * marked the moment it is claimed), silent (unknown/unpublished slugs and
 * API failures just remove the slot), and non-blocking — the room is
 * already open and readable while these resolve.
 */
export function hydratePageBlocks(root: ParentNode): Promise<void> {
  const slots = root.querySelectorAll<HTMLElement>(
    '.' + BLOCK_SLOT_CLASS + '[data-page-slug]:not([data-pc-state])',
  );
  const jobs: Promise<void>[] = [];
  for (const slot of slots) {
    const slug = slot.dataset.pageSlug ?? '';
    slot.dataset.pcState = 'loading';
    if (!slug) {
      slot.remove();
      continue;
    }
    const job = resolvePageCard(slug).then((card) => {
      if (!slot.isConnected) return;
      const grid = slot.parentElement;
      if (card === null) {
        /* unknown, draft or unpublished — the block renders nothing */
        slot.remove();
      } else {
        slot.dataset.pcState = 'ready';
        slot.appendChild(createPageCard(card));
      }
      /* a grid whose every block vanished leaves no gap behind */
      if (grid && grid.classList.contains(BLOCK_GRID_CLASS) && grid.childElementCount === 0) {
        grid.remove();
      }
    });
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
}

export default createPageCard;
