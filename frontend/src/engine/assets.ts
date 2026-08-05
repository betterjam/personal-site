/**
 * ASSET REGISTRY — the 'asset:<token>' half of a page's `image` field and
 * of every `gallery` entry.
 *
 * A picture is referenced two ways: an absolute 'https://…' URL (used
 * verbatim) or an 'asset:<token>' reference into THIS registry of images
 * bundled with the frontend. Tokens are content-side names, so a page
 * authored as `image: asset:maintainer` keeps working across rebuilds
 * while the URL underneath grows a new content hash.
 *
 * DISCOVERY — the registry is not a hand-written list. Everything under
 * src/assets is globbed at build time, and a file at
 * '<folder>/<name>.<ext>' registers TWO tokens:
 *   - the QUALIFIED token '<folder>/<name>' — always;
 *   - the BARE token '<name>' — only when that name is unique across all
 *     folders. On a collision the bare alias is dropped (both files stay
 *     reachable by their qualified tokens) and the build logs it: the
 *     asset-meta plugin in vite.config.ts says it once in the build log,
 *     and this module says it once in the browser console.
 * A file at the root of src/assets has no folder, so its qualified token
 * IS its bare name ('maintainer').
 *
 * FORMATS — one token, one picture: when the same '<folder>/<name>' exists
 * in several formats (a PNG original beside the WebP derivative
 * tools/optimize-shots.mjs writes) the registry serves the most efficient
 * one, webp > jpeg > png. Dropping derivatives next to the originals
 * therefore upgrades the site with no content change.
 *
 * QUARANTINE — src/assets/_review holds screenshots pulled aside for
 * personal or customer data. It is excluded from the glob below and from
 * the plugin's walk: it must never reach a bundle.
 *
 * Unknown token → null. Every caller treats null as 'no image' and draws
 * the quiet monogram placeholder (or nothing) instead — a broken
 * reference is never a broken picture.
 */
import ASSET_META from 'virtual:asset-meta';

export interface AssetImage {
  url: string;
  /** Honest alt text — these are real captures, described as such. */
  alt: string;
  /** Intrinsic size, declared so frames reserve layout before decode. */
  width: number;
  height: number;
  /** What this picture actually is — the showcase prints it under a frame. */
  caption?: string;
  /** The token it answers to — the mono label a browser frame wears. */
  token: string;
}

/* --------------------------------------------------------------- the glob
   Eager + '?url': every match becomes a hashed URL emitted by the build.
   The negative pattern keeps the quarantine out of the bundle; the runtime
   guard below keeps it out even if that pattern is ever loosened. */
const ASSET_URLS = import.meta.glob<string>(
  ['../assets/**/*.{png,webp,jpg,jpeg}', '!../assets/_review/**'],
  { eager: true, query: '?url', import: 'default' },
);

const PREFIX = '../assets/';
const QUARANTINE = '_review/';
/** Serving preference when one token has several formats on disk. */
const FORMAT_RANK: Record<string, number> = { webp: 3, jpg: 2, jpeg: 2, png: 1 };
/** A token is exactly what the API's validator accepts after 'asset:'. */
const TOKEN_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/;

/** 'org-chart-editor' → 'org chart editor'. */
function words(slugish: string): string {
  return slugish.replace(/-+/g, ' ').trim();
}

/**
 * Alt text derived from the token: honest about what the file is without
 * inventing what is inside it. A curated entry in ALT_TEXT wins — that is
 * where a picture worth describing properly gets described properly.
 */
function derivedAlt(folder: string, name: string): string {
  const what = words(name);
  return folder ? `Screenshot: ${what} — ${words(folder)}` : `Screenshot: ${what}`;
}

/**
 * Curated descriptions, by qualified token. Everything else falls back to
 * derivedAlt(); a picture only earns a line here when the words add
 * something a reader (or a screen reader) could not get from the filename.
 */
const ALT_TEXT: Record<string, string> = {
  maintainer:
    'The maintainer console of this site: Posts and Pages tabs, a posts table with status chips on the left, and a published post open in the editor on the right.',
};

/** Curated captions — printed under a frame where one is drawn. */
const CAPTIONS: Record<string, string> = {
  maintainer: 'the real maintainer console, captured from the running app',
};

interface Entry {
  token: string;
  folder: string;
  name: string;
  ext: string;
  url: string;
  rank: number;
}

function parseKey(key: string): Entry | null {
  const rel = key.slice(PREFIX.length);
  if (rel.startsWith(QUARANTINE)) return null; /* never, under any glob */
  const cut = rel.lastIndexOf('/');
  const folder = cut < 0 ? '' : rel.slice(0, cut);
  const file = cut < 0 ? rel : rel.slice(cut + 1);
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const name = file.slice(0, dot);
  const ext = file.slice(dot + 1).toLowerCase();
  const token = folder ? folder + '/' + name : name;
  if (!TOKEN_RE.test(token)) return null; /* unreferenceable — skip it */
  return { token, folder, name, ext, url: ASSET_URLS[key], rank: FORMAT_RANK[ext] ?? 0 };
}

function buildRegistry(): Record<string, AssetImage> {
  const best = new Map<string, Entry>();
  const keyOf = new Map<string, string>(); /* token → glob key, for sizes */
  const bare = new Map<string, Set<string>>(); /* bare name → qualified tokens */

  for (const key of Object.keys(ASSET_URLS)) {
    const entry = parseKey(key);
    if (entry === null) continue;
    const held = best.get(entry.token);
    /* one token, one picture: the most efficient format on disk wins */
    if (held === undefined || entry.rank > held.rank) {
      best.set(entry.token, entry);
      keyOf.set(entry.token, key);
    }
    const set = bare.get(entry.name) ?? new Set<string>();
    set.add(entry.token);
    bare.set(entry.name, set);
  }

  const out: Record<string, AssetImage> = {};
  for (const [token, entry] of best) {
    const rel = (keyOf.get(token) ?? '').slice(PREFIX.length);
    const size = ASSET_META[rel];
    out[token] = {
      url: entry.url,
      alt: ALT_TEXT[token] ?? derivedAlt(entry.folder, entry.name),
      width: size ? size[0] : 0,
      height: size ? size[1] : 0,
      caption: CAPTIONS[token],
      token,
    };
  }

  /* bare aliases — only where the name is unambiguous across folders */
  const collisions: string[] = [];
  for (const [name, tokens] of bare) {
    if (out[name] !== undefined) continue; /* a root-level file owns it */
    if (tokens.size > 1) {
      collisions.push(`'${name}' (${[...tokens].sort().join(', ')})`);
      continue;
    }
    const only = [...tokens][0];
    const img = out[only];
    if (img) out[name] = img;
  }
  if (collisions.length > 0) {
    /* the build says this too (vite.config.ts's asset-meta plugin); this is
       the same sentence where a maintainer actually types a token */
    console.warn(
      '[assets] bare token collision — reference these by their <folder>/<name> tokens: ' +
        collisions.join('; '),
    );
  }
  return out;
}

/** The bundled images, by token (qualified and, where unique, bare). */
export const ASSETS: Record<string, AssetImage> = buildRegistry();

/** Every QUALIFIED token, sorted — the maintainer console lists these. */
export const ASSET_TOKENS: string[] = Object.keys(ASSETS)
  .filter((t) => ASSETS[t].token === t)
  .sort();

/** The contract's reference shape — mirrored from the API's validator. */
export const ASSET_REF_RE = /^asset:([a-z0-9-]+(?:\/[a-z0-9-]+)?)$/;

/** True when the string is a well-formed reference (not that it resolves). */
export function isImageRef(ref: string): boolean {
  return ASSET_REF_RE.test(ref) || /^https:\/\/\S+$/i.test(ref);
}

/** True for a well-formed 'asset:' reference naming nothing we bundle. */
export function isUnknownAssetRef(ref: string): boolean {
  const m = ASSET_REF_RE.exec(ref.trim());
  return m !== null && ASSETS[m[1]] === undefined;
}

/**
 * Resolve an image reference.
 *   'asset:eleva-app/org-chart-editor' → the bundled capture (+ intrinsics)
 *   'asset:maintainer'                 → the same, by bare token
 *   'https://…'                        → that URL, no alt of our own
 *   anything else / unknown token / absent → null (→ placeholder)
 */
export function resolveImage(ref: string | undefined | null): AssetImage | null {
  if (typeof ref !== 'string') return null;
  const value = ref.trim();
  if (value === '') return null;
  const m = ASSET_REF_RE.exec(value);
  if (m) return ASSETS[m[1]] ?? null;
  if (/^https:\/\/\S+$/i.test(value)) {
    /* an external picture describes itself: no alt we could honestly write,
       and no intrinsic size we could know before it decodes */
    return { url: value, alt: '', width: 0, height: 0, token: value.replace(/^https:\/\//i, '') };
  }
  return null;
}

/** Initials for the placeholder monogram — 'This Site' → 'TS'. */
export function monogram(title: string): string {
  const words = title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 2);
  if (words.length === 0) return '·';
  return words.map((w) => w.charAt(0).toUpperCase()).join('');
}
