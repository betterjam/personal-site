/**
 * Front matter for authored page files: an OPTIONAL leading block delimited
 * by '---' lines carrying the card metadata that has no place in the prose.
 *
 *     ---
 *     summary: One sentence a card can wear.
 *     image: asset:maintainer
 *     repo: betterjam/eleva-aws-infra-control
 *     gallery: asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/question-bank-catalog|Question bank
 *     ---
 *     # Title
 *
 *     First paragraph...
 *
 * Deliberately not a YAML parser — a flat `key: value` list, one per line,
 * where only `summary`, `image`, `repo` and `gallery` are recognized and
 * every other key is ignored (a file authored against a newer build still
 * seeds cleanly on an older one). Values are trimmed and may be wrapped in
 * matching quotes; only the FIRST colon splits, so `image: asset:maintainer`
 * and `https://...` values survive intact. An empty value is the same as an
 * absent key.
 *
 * `gallery` is the one list-valued key: a COMMA-separated list of
 * references, each optionally followed by `|` and a caption. Whitespace
 * around items, refs and captions is trimmed; an item with no pipe has no
 * caption; an item with nothing before the pipe is skipped rather than
 * seeded as a broken picture. A caption MAY hold commas: a comma starts the
 * next entry only when what follows it opens a reference (see
 * parseGalleryList).
 *
 * The parser never guesses: a file that does not OPEN with a '---' line, or
 * whose block is never closed, has no front matter and passes through
 * byte-for-byte. The flip side of the same rule — the standard front matter
 * ambiguity — is that a file whose very first line is a horizontal rule is
 * read as an (unterminated, therefore ignored) front matter block.
 */

import { PageGalleryEntry } from './events';

/** The recognized keys, each optional. */
export interface PageFrontMatter {
  summary?: string;
  image?: string;
  /** `owner/name` of the repository the page is about. */
  repo?: string;
  /** Parsed `gallery:` list; absent (never `[]`) when the key holds nothing. */
  gallery?: PageGalleryEntry[];
}

/** The single-value keys, all handled identically. */
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
 * (empty, caption-only) are dropped and the rest of the list still seeds.
 * Format validation of each ref happens where the API's rules live, not
 * here — the parser reports what was written.
 *
 * One refinement on "split at every comma": a comma only starts a new entry
 * when what follows it begins a reference (`asset:` or `https://`).
 * Otherwise it belongs to the caption being written, so
 * `asset:x|Live docs, generated from the modules` stays ONE picture with
 * its whole sentence rather than becoming a picture and a broken reference.
 */
export function parseGalleryList(value: string): PageGalleryEntry[] {
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

  const entries: PageGalleryEntry[] = [];
  for (const item of items) {
    const pipe = item.indexOf('|');
    const ref = (pipe === -1 ? item : item.slice(0, pipe)).trim();
    if (ref === '') {
      continue; // '', ', ,' and '|caption' are noise, not entries.
    }
    const caption = pipe === -1 ? '' : item.slice(pipe + 1).trim();
    entries.push({ ref, ...(caption !== '' ? { caption } : {}) });
  }
  return entries;
}

export interface ParsedFrontMatter {
  attributes: PageFrontMatter;
  /** The file with the front matter block (and any blank lines after it) removed. */
  body: string;
}

const DELIMITER = '---';

/**
 * Splits a raw seed file into its front matter attributes and the body that
 * remains. Callers apply the '# Title' rule to `body`, which is why the
 * blank lines following the closing delimiter are dropped here: a heading
 * pushed down by front matter must still read as the page's title.
 */
export function parseFrontMatter(raw: string): ParsedFrontMatter {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) {
    return { attributes: {}, body: raw };
  }
  const close = lines.findIndex(
    (line, index) => index > 0 && line.trim() === DELIMITER,
  );
  if (close === -1) {
    // Opened but never closed: not front matter, hands off the file.
    return { attributes: {}, body: raw };
  }

  const attributes: PageFrontMatter = {};
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1).trim());
    if (value === '') {
      continue; // An empty value is the same as an absent key.
    }
    if (isTextKey(key)) {
      attributes[key] = value;
    } else if (key === 'gallery') {
      const gallery = parseGalleryList(value);
      if (gallery.length > 0) {
        attributes.gallery = gallery;
      }
    }
    // Unknown keys are ignored, never an error.
  }

  let rest = lines.slice(close + 1);
  while (rest[0]?.trim() === '') {
    rest = rest.slice(1);
  }
  return { attributes, body: rest.join('\n') };
}

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
