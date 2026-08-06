/**
 * PAGE SEED PARSER — the repo's authored pages, read the way the SERVER
 * reads them.
 *
 * This module runs at BUILD time only (the page-snapshot plugin in
 * vite.config.ts calls it from Node); nothing in the browser bundle
 * imports it, and src/engine/snapshot.ts takes only its TYPES, which
 * erase. It is deliberately free of Node APIs — strings in, parsed pages
 * out — so it type-checks under the browser tsconfig alongside everything
 * else and can never drift into doing I/O.
 *
 * WHY IT EXISTS. content/pages/*.md is the seed corpus the API's
 * PagesService replays into its log on first boot
 * (app/src/pages/pages.service.ts + app/src/pages/front-matter.ts). The
 * frontend bundles the SAME files as its offline floor, so a page must
 * read identically whether it arrived over /api/pages/<slug> or out of
 * the snapshot. That means matching the server's semantics exactly, not
 * approximately:
 *
 *   - front matter is an OPTIONAL leading '---' block of flat `key: value`
 *     lines; only summary/image/repo/gallery are recognized, only the
 *     FIRST colon splits, values may wear one pair of matching quotes, an
 *     empty value is the same as an absent key, unknown keys are ignored;
 *   - a file that does not OPEN with '---', or whose block never closes,
 *     has NO front matter and passes through byte-for-byte;
 *   - `gallery` is comma-separated `ref|caption` items, where a comma only
 *     starts a new entry when what follows it OPENS a reference — so a
 *     caption may hold commas;
 *   - a leading '# Title' line (after the front matter is removed) becomes
 *     the title and leaves the body; otherwise the slug is humanized;
 *   - the same field gates the seeder applies: an over-long summary, an
 *     image/gallery ref that is neither https:// nor asset:<token>, or a
 *     malformed repo is DROPPED (with a build warning), never fatal, and
 *     a gallery is capped at 24 entries.
 *
 * Mirrors: app/src/pages/front-matter.ts, app/src/pages/validate.ts and
 * splitSeedFile()/seedMeta() in app/src/pages/pages.service.ts. Change one
 * side and this side changes with it.
 */

/** One picture in a page's strip — the API's { ref, caption? }, mirrored. */
export interface SeedGalleryEntry {
  ref: string;
  /** Absent, never empty, when the shot speaks for itself. */
  caption?: string;
}

/** The recognized front-matter keys, each optional. */
export interface SeedFrontMatter {
  summary?: string;
  image?: string;
  /** `owner/name` of the repository the page is about. */
  repo?: string;
  /** Parsed `gallery:` list; absent (never `[]`) when the key holds nothing. */
  gallery?: SeedGalleryEntry[];
}

/**
 * One page as the repo published it. The browser's snapshot module wears
 * this shape and lifts it into the API's PageView; the two agree field by
 * field, which is the whole point.
 */
export interface SnapshotPage {
  slug: string;
  title: string;
  body: string;
  summary?: string;
  image?: string;
  repo?: string;
  gallery?: SeedGalleryEntry[];
}

/* --------------------------------------------------------- front matter */

const TEXT_KEYS = ['summary', 'image', 'repo'] as const;
type TextKey = (typeof TEXT_KEYS)[number];

function isTextKey(key: string): key is TextKey {
  return (TEXT_KEYS as readonly string[]).includes(key);
}

/** What an entry starts with, and therefore where a comma really splits. */
const REF_START = /^(?:asset:|https:\/\/)/;

/**
 * 'a|Caption, b' -> [{ref:'a', caption:'Caption'}, {ref:'b'}]. Nothing here
 * throws: an authored file is not a payload, so items that make no sense
 * (empty, caption-only) are dropped and the rest of the list still parses.
 */
export function parseGalleryList(value: string): SeedGalleryEntry[] {
  const items: string[] = [];
  for (const chunk of value.split(',')) {
    const open = items.length > 0 ? items[items.length - 1] : undefined;
    const continuesCaption =
      open !== undefined && open.includes('|') && !REF_START.test(chunk.trim());
    if (continuesCaption) {
      items[items.length - 1] = `${open},${chunk}`;
      continue;
    }
    items.push(chunk);
  }

  const entries: SeedGalleryEntry[] = [];
  for (const item of items) {
    const pipe = item.indexOf('|');
    const ref = (pipe === -1 ? item : item.slice(0, pipe)).trim();
    if (ref === '') {
      continue; /* '', ', ,' and '|caption' are noise, not entries */
    }
    const caption = pipe === -1 ? '' : item.slice(pipe + 1).trim();
    entries.push({ ref, ...(caption !== '' ? { caption } : {}) });
  }
  return entries;
}

export interface ParsedFrontMatter {
  attributes: SeedFrontMatter;
  /** The file with the block (and the blank lines after it) removed. */
  body: string;
}

const DELIMITER = '---';

/** Strips one pair of matching wrapping quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * Splits a raw seed file into its front-matter attributes and the body
 * that remains. The blank lines after the closing delimiter are dropped
 * here so a heading pushed down by front matter still reads as the title.
 */
export function parseFrontMatter(raw: string): ParsedFrontMatter {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) {
    return { attributes: {}, body: raw };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (close === -1) {
    /* opened but never closed: not front matter, hands off the file */
    return { attributes: {}, body: raw };
  }

  const attributes: SeedFrontMatter = {};
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1).trim());
    if (value === '') {
      continue; /* an empty value is the same as an absent key */
    }
    if (isTextKey(key)) {
      attributes[key] = value;
    } else if (key === 'gallery') {
      const gallery = parseGalleryList(value);
      if (gallery.length > 0) {
        attributes.gallery = gallery;
      }
    }
    /* unknown keys are ignored, never an error */
  }

  let rest = lines.slice(close + 1);
  while (rest[0]?.trim() === '') {
    rest = rest.slice(1);
  }
  return { attributes, body: rest.join('\n') };
}

/* ------------------------------------------------------------- the gates
   One rule per field, the same rule the API's validator applies, so a
   snapshot page can never carry a value the live API would have refused. */

/** A card summary is a card, not the page: hard cap, no exceptions. */
export const SUMMARY_MAX_LENGTH = 300;
/** A gallery is a strip, not an archive: hard cap, no exceptions. */
export const GALLERY_MAX_ENTRIES = 24;

/** `asset:<token>`, bare or folder-qualified — exactly one slash. */
const ASSET_IMAGE = /^asset:[a-z0-9-]+(?:\/[a-z0-9-]+)?$/;
/** Remote images must be https — never http:, data:, javascript:, '//host'. */
const HTTPS_IMAGE = /^https:\/\/[^\s<>"']+$/;
/** `owner/name` over the characters GitHub itself allows. */
const REPO_REF = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
/** '.', '..', '...': pattern-legal, traversal-shaped, never a real repo. */
const ALL_DOTS = /^\.+$/;

export function isValidPageSummary(value: string): boolean {
  return value.length <= SUMMARY_MAX_LENGTH;
}

export function isValidPageImage(value: string): boolean {
  return ASSET_IMAGE.test(value) || HTTPS_IMAGE.test(value);
}

export function isValidPageRepo(value: string): boolean {
  if (!REPO_REF.test(value)) return false;
  const [owner, name] = value.split('/');
  return !ALL_DOTS.test(owner) && !ALL_DOTS.test(name);
}

/* ------------------------------------------------------ title and body */

/** 'working-with-me' -> 'Working With Me'. */
function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Title/body split for one authored seed file, front matter already gone.
 * A '# Heading' first line becomes the title (that line and one following
 * blank line leave the body); otherwise the filename is humanized and the
 * whole file is the body. The body is trimmed either way.
 */
export function splitSeedFile(slug: string, raw: string): { title: string; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.startsWith('# ')) {
    const title = lines[0].slice(2).trim();
    let rest = lines.slice(1);
    if (rest[0]?.trim() === '') rest = rest.slice(1);
    return { title, body: rest.join('\n').trim() };
  }
  return { title: humanize(slug), body: raw.trim() };
}

/* ----------------------------------------------------------- one page */

export interface SeedResult {
  page: SnapshotPage;
  /** What was dropped, in the seeder's words — the build log says them. */
  warnings: string[];
}

/**
 * One authored file → one snapshot page. Never throws: a bad line costs
 * its own field, exactly as it costs the seeder's, and the page still
 * publishes. The caller reports `warnings` to the build log so a broken
 * reference is loud at build time instead of silent in a browser.
 */
export function pageFromSeedFile(slug: string, raw: string): SeedResult {
  const warnings: string[] = [];
  const { attributes, body: stripped } = parseFrontMatter(raw);
  const { title, body } = splitSeedFile(slug, stripped);
  const page: SnapshotPage = { slug, title, body };

  if (attributes.summary !== undefined) {
    if (isValidPageSummary(attributes.summary)) {
      page.summary = attributes.summary;
    } else {
      warnings.push(`ignoring over-long summary in front matter of ${slug}.md`);
    }
  }
  if (attributes.image !== undefined) {
    if (isValidPageImage(attributes.image)) {
      page.image = attributes.image;
    } else {
      warnings.push(
        `ignoring unsupported image "${attributes.image}" in front matter of ${slug}.md`,
      );
    }
  }
  if (attributes.repo !== undefined) {
    if (isValidPageRepo(attributes.repo)) {
      page.repo = attributes.repo;
    } else {
      warnings.push(`ignoring malformed repo "${attributes.repo}" in front matter of ${slug}.md`);
    }
  }
  if (attributes.gallery !== undefined) {
    const kept = attributes.gallery.filter((entry) => {
      if (isValidPageImage(entry.ref)) return true;
      warnings.push(
        `ignoring unsupported gallery ref "${entry.ref}" in front matter of ${slug}.md`,
      );
      return false;
    });
    if (kept.length > GALLERY_MAX_ENTRIES) {
      warnings.push(
        `ignoring ${kept.length - GALLERY_MAX_ENTRIES} gallery entry(ies) past the ` +
          `${GALLERY_MAX_ENTRIES}-entry cap in front matter of ${slug}.md`,
      );
    }
    const gallery = kept.slice(0, GALLERY_MAX_ENTRIES);
    if (gallery.length > 0) page.gallery = gallery;
  }

  return { page, warnings };
}
