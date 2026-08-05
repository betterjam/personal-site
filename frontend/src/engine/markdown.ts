/**
 * STRICT-SUBSET Markdown → DOM. One pure function, no state, no HTML
 * strings anywhere: the fragment is built ONLY via createElement /
 * createTextNode / textContent, so literal '<' '>' in the source render
 * as text and there is no raw-HTML pass-through by construction.
 *
 * The subset (anything else is plain text):
 *   blocks — '#'/'##'/'###' headings (→ h2/h3/h4: the reading rooms title
 *   with an h2, so body headings nest under it), paragraphs (blank-line
 *   separated; single newlines join with a space), ``` fenced code
 *   (language tag ignored, content verbatim), '- ' and '1. ' lists
 *   (non-nested), '>' blockquotes ('>' on its own line splits quote
 *   paragraphs), and EMBED BLOCKS — '!page[slug]' (a published page's
 *   card), '!repo[owner/name]' (a GitHub repository widget),
 *   '!image[ref|caption]' (one framed figure) and
 *   '!gallery[ref|caption, ref, …]' (a thumbnail grid). A paragraph
 *   consisting solely of one of those markers becomes an (empty) slot;
 *   CONSECUTIVE such paragraphs group into ONE container per KIND of
 *   container — page cards and repo widgets share the card grid (mixed
 *   freely, so an authored index page reproduces the section style), a
 *   run of '!image' blocks shares one figure grid, and a '!gallery'
 *   block is a grid already and therefore always stands alone. This
 *   function stays pure and synchronous: it emits inert placeholders —
 *   '.pg-blocks > .pg-block' carrying data-page-slug or data-repo,
 *   '.gl-figs > .gl-fig' carrying data-image, '.gl-mount' carrying
 *   data-gallery — and engine/pageCard.ts's hydratePageBlocks(),
 *   engine/repoCard.ts's hydrateRepoBlocks() and engine/gallery.ts's
 *   hydrateGalleryBlocks() fill them in afterwards (an unknown or
 *   unpublished slug, a malformed repo reference and an unresolvable
 *   picture all simply vanish).
 *   inline — **bold**, *italic*, `code` (verbatim), [text](url) links
 *   whose url starts with https:// mailto: or '#'; any other scheme
 *   renders the whole [text](url) as literal text. Unclosed markers
 *   render literally. Links never nest inside link text.
 */

const SAFE_HREF = /^(?:https:\/\/|mailto:|#)/i;
const LINK_RE = /^\[([^\]]*)\]\(([^()\s]+)\)/;
const UL_RE = /^-\s+/;
const OL_RE = /^\d+\.\s+/;
const HEADING_TAGS = ['h2', 'h3', 'h4'] as const;
const PAGE_BLOCK_RE = /^!page\[([^\]\s]+)\]$/;
const REPO_BLOCK_RE = /^!repo\[([^\]\s]+)\]$/;
/* pictures carry captions, so their payload may hold spaces */
const IMAGE_BLOCK_RE = /^!image\[([^\]]+)\]$/;
const GALLERY_BLOCK_RE = /^!gallery\[([^\]]+)\]$/;

/** A slot's payload: a page slug, an 'owner/name', or a picture list. */
interface EmbedBlock {
  kind: 'page' | 'repo' | 'image' | 'gallery';
  value: string;
}

/**
 * The container an embed belongs in. Page cards and repo widgets share the
 * card grid; '!image' blocks share the figure grid; a '!gallery' IS a grid,
 * so it groups with nothing — a run of embeds opens a new container every
 * time this changes.
 */
type BlockGroup = 'cards' | 'figures' | 'gallery';

function groupOf(kind: EmbedBlock['kind']): BlockGroup {
  if (kind === 'image') return 'figures';
  if (kind === 'gallery') return 'gallery';
  return 'cards';
}

/**
 * The embed on a line that is a block ON ITS OWN — nothing before it in
 * the paragraph (the caller checks that) and a blank line or EOF after
 * it. '!page[x] and words' stays plain text, by design; so does
 * '!repo[owner/name] and words' and '!image[ref] and words'.
 */
function embedBlockAt(lines: string[], i: number): EmbedBlock | null {
  if (i >= lines.length) return null;
  const next = lines[i + 1];
  if (next !== undefined && next.trim() !== '') return null;
  const line = lines[i].trim();
  const page = PAGE_BLOCK_RE.exec(line);
  if (page) return { kind: 'page', value: page[1] };
  const repo = REPO_BLOCK_RE.exec(line);
  if (repo) return { kind: 'repo', value: repo[1] };
  const image = IMAGE_BLOCK_RE.exec(line);
  if (image) return { kind: 'image', value: image[1].trim() };
  const gallery = GALLERY_BLOCK_RE.exec(line);
  if (gallery) return { kind: 'gallery', value: gallery[1].trim() };
  return null;
}

/** The empty container a run of one group fills. */
function openContainer(group: BlockGroup): HTMLDivElement {
  const node = document.createElement('div');
  node.className = group === 'cards' ? 'pg-blocks' : group === 'figures' ? 'gl-figs' : 'gl-mount';
  return node;
}

/** The inert slot ONE embed leaves behind, for its hydrator to claim.
    A gallery has none: its container carries the whole list itself. */
function slotFor(kind: Exclude<EmbedBlock['kind'], 'gallery'>, value: string): HTMLDivElement {
  const slot = document.createElement('div');
  if (kind === 'image') {
    slot.className = 'gl-fig';
    slot.dataset.image = value;
    return slot;
  }
  slot.className = 'pg-block';
  if (kind === 'page') slot.dataset.pageSlug = value;
  else slot.dataset.repo = value;
  return slot;
}

function text(parent: Node, s: string): void {
  if (s) parent.appendChild(document.createTextNode(s));
}

/** Inline pass: bold / italic / code / safe links, recursive for nesting. */
function appendInline(parent: Node, src: string, allowLinks: boolean): void {
  let plain = '';
  let i = 0;
  const flush = (): void => {
    text(parent, plain);
    plain = '';
  };
  while (i < src.length) {
    const ch = src.charAt(i);

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        const code = document.createElement('code');
        code.textContent = src.slice(i + 1, end);
        parent.appendChild(code);
        i = end + 1;
        continue;
      }
    } else if (ch === '*') {
      if (src.startsWith('**', i)) {
        const end = src.indexOf('**', i + 2);
        if (end > i + 1) {
          flush();
          const strong = document.createElement('strong');
          appendInline(strong, src.slice(i + 2, end), allowLinks);
          parent.appendChild(strong);
          i = end + 2;
          continue;
        }
      } else {
        const end = src.indexOf('*', i + 1);
        if (end > i) {
          flush();
          const em = document.createElement('em');
          appendInline(em, src.slice(i + 1, end), allowLinks);
          parent.appendChild(em);
          i = end + 1;
          continue;
        }
      }
    } else if (ch === '[' && allowLinks) {
      const m = LINK_RE.exec(src.slice(i));
      if (m && SAFE_HREF.test(m[2])) {
        flush();
        const a = document.createElement('a');
        a.href = m[2]; /* gated by SAFE_HREF: https:// mailto: '#' only */
        appendInline(a, m[1], false);
        parent.appendChild(a);
        i += m[0].length;
        continue;
      }
      /* unsafe scheme or malformed → falls through as literal text */
    }

    plain += ch;
    i += 1;
  }
  flush();
}

/** The renderer. Pure: same string in, equivalent fragment out. */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];

  const flushPara = (): void => {
    if (!para.length) return;
    const p = document.createElement('p');
    appendInline(p, para.join(' '), true);
    frag.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    /* fenced code — verbatim until the closing fence (or EOF) */
    if (line.startsWith('```')) {
      flushPara();
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; /* skip the closing fence */
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    /* embed blocks — a run of consecutive embed paragraphs becomes one
       container PER GROUP: page cards and repo widgets mix inside the card
       grid, '!image' blocks fill the figure grid beside each other, and a
       '!gallery' is a grid already so it always stands alone. The slots
       stay empty until hydratePageBlocks() / hydrateRepoBlocks() /
       hydrateGalleryBlocks() resolve them (this renderer never fetches) */
    if (para.length === 0 && embedBlockAt(lines, i) !== null) {
      let j = i;
      let group: BlockGroup | null = null;
      let container: HTMLDivElement | null = null;
      for (;;) {
        const embed = embedBlockAt(lines, j);
        if (embed === null) break;
        const next = groupOf(embed.kind);
        /* a new container whenever the group changes — and always for a
           gallery, which never shares one */
        if (container === null || next !== group || next === 'gallery') {
          container = openContainer(next);
          group = next;
          frag.appendChild(container);
        }
        if (embed.kind === 'gallery') container.dataset.gallery = embed.value;
        else container.appendChild(slotFor(embed.kind, embed.value));
        j += 1; /* the marker line */
        while (j < lines.length && lines[j].trim() === '') j += 1; /* the gap */
      }
      i = j;
      continue;
    }

    /* headings — #### and beyond is NOT a heading, stays a paragraph */
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const hd = document.createElement(HEADING_TAGS[h[1].length - 1]);
      appendInline(hd, h[2].trim(), true);
      frag.appendChild(hd);
      i += 1;
      continue;
    }

    /* blockquote — consecutive '>' lines; a bare '>' splits paragraphs */
    if (line.startsWith('>')) {
      flushPara();
      const bq = document.createElement('blockquote');
      let qp: string[] = [];
      const flushQuotePara = (): void => {
        if (!qp.length) return;
        const p = document.createElement('p');
        appendInline(p, qp.join(' '), true);
        bq.appendChild(p);
        qp = [];
      };
      while (i < lines.length && lines[i].startsWith('>')) {
        const inner = lines[i].replace(/^>\s?/, '');
        if (inner.trim() === '') flushQuotePara();
        else qp.push(inner);
        i += 1;
      }
      flushQuotePara();
      frag.appendChild(bq);
      continue;
    }

    /* flat lists — '- ' or '1. ', one item per line, no nesting */
    const isUl = UL_RE.test(line);
    if (isUl || OL_RE.test(line)) {
      flushPara();
      const list = document.createElement(isUl ? 'ul' : 'ol');
      const marker = isUl ? UL_RE : OL_RE;
      while (i < lines.length && marker.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(marker, ''), true);
        list.appendChild(li);
        i += 1;
      }
      frag.appendChild(list);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return frag;
}

export default renderMarkdown;
