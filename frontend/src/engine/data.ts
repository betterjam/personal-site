/**
 * Static content + theme data (bundled at build time) and the posts/meta
 * API client. All JSON lives outside the vite root, in the repo's
 * content/ and themes/ directories — one content.json, every finish.
 */
import type { GalleryEntry } from './gallery';
import contentJson from '../../../content/content.json';
import roadmapJson from '../../../content/roadmap.json';
import mixtapeJson from '../../../themes/mixtape.json';
import seafoamStudioJson from '../../../themes/seafoam-studio.json';
import candyParticlesJson from '../../../themes/candy-particles.json';
import surfOrbitJson from '../../../themes/surf-orbit.json';
import pedalboardJson from '../../../themes/pedalboard.json';
import eventLogJson from '../../../themes/event-log.json';
import sunburstEditorialJson from '../../../themes/sunburst-editorial.json';

/* ---------------------------------------------------------------- content */

export interface ProfileLink {
  label: string;
  url: string;
}

export interface Profile {
  name: string;
  role: string;
  tagline: string;
  location: string;
  contact: string;
  links: ProfileLink[];
}

/**
 * An item authored INLINE in content.json — the classic card copy every
 * band renderer knows how to draw.
 */
export interface InlineItem {
  title: string;
  deck: string;
  tags?: string[];
  date?: string;
}

/**
 * A PAGE BLOCK — the item's copy lives on a published page instead of in
 * content.json: { "page": "<slug>", "tags"?: [...] }. The card resolves at
 * runtime through resolvePageCard(); an unpublished (or unknown) slug
 * resolves to null and the block renders NOTHING, everywhere.
 */
export interface PageBlock {
  page: string;
  tags?: string[];
}

/** content.json section items are one or the other, never both. */
export type SectionItem = InlineItem | PageBlock;

/** Historical name for the inline shape — kept so older imports read. */
export type ContentItem = InlineItem;

export function isPageBlock(item: SectionItem): item is PageBlock {
  return typeof (item as PageBlock).page === 'string';
}

/**
 * The narrowing every OTHER band renderer uses: page blocks are a
 * showcase/markdown feature, so the rest of the deck simply reads the
 * inline items and is untouched by the union.
 */
export function inlineItems(section: ContentSection): InlineItem[] {
  return section.items.filter((it): it is InlineItem => !isPageBlock(it));
}

/** Tags of any item shape — a block carries its own tag row. */
export function itemTagsOf(item: SectionItem): string[] {
  return item.tags ?? [];
}

export interface ContentSection {
  id: string;
  label: string;
  kicker: string;
  headline: string;
  summary: string;
  items: SectionItem[];
}

export interface SiteContent {
  profile: Profile;
  sections: ContentSection[];
}

/* ---------------------------------------------------------------- themes */

export interface ThemeTypeFace {
  stack: string;
  note?: string;
}

export interface ThemeMotion {
  paradigm?: string;
  note?: string;
  tempo?: Record<string, number>;
  eases?: Record<string, string>;
  params?: Record<string, number | string | boolean>;
}

export interface ThemeSpec {
  id: string;
  name: string;
  inspiration?: string;
  stage: 'light' | 'dark';
  palette: Record<string, string>;
  type: {
    display: ThemeTypeFace;
    body: ThemeTypeFace;
    utility: ThemeTypeFace;
  };
  motion?: ThemeMotion;
}

/* ---------------------------------------------------------------- mixtape */

export interface MixtapeSection {
  theme: string;
  renderer: string;
  note?: string;
}

export interface MixtapeTransition {
  engine: string;
  theme: string;
  recolorInFlight: boolean;
  note?: string;
  tempo: { disperse: number; swarm: number; converge: number; reveal: number };
  params: {
    particleCount: number;
    particleSizePx: number;
    scatterRadiusVmax: number;
  };
}

export interface MixtapeSpec {
  id: string;
  name: string;
  inspiration?: string;
  stage: 'light' | 'dark';
  hub: { theme: string; renderer: string; note?: string };
  transition: MixtapeTransition;
  sections: Record<string, MixtapeSection>;
  themeRefs: string[];
}

/* ---------------------------------------------------------------- roadmap */

export type RoadmapStatus = 'done' | 'doing' | 'next';

export interface RoadmapItem {
  title: string;
  status: RoadmapStatus;
}

export interface Roadmap {
  note?: string;
  items: RoadmapItem[];
}

/* ------------------------------------------------------------ typed data */

export const CONTENT: SiteContent = contentJson as SiteContent;
export const ROADMAP: Roadmap = roadmapJson as Roadmap;
export const MIXTAPE: MixtapeSpec = mixtapeJson as MixtapeSpec;

export const THEMES: Record<string, ThemeSpec> = {
  'seafoam-studio': seafoamStudioJson as ThemeSpec,
  'candy-particles': candyParticlesJson as ThemeSpec,
  'surf-orbit': surfOrbitJson as ThemeSpec,
  pedalboard: pedalboardJson as ThemeSpec,
  'event-log': eventLogJson as ThemeSpec,
  'sunburst-editorial': sunburstEditorialJson as ThemeSpec,
};

export const HUB_THEME_ID = MIXTAPE.hub.theme;

/* -------------------------------------------------------- posts API client */

/** The blog read model — one shape for public and admin projections. */
export interface PostView {
  slug: string;
  title: string;
  deck: string;
  tags: string[];
  body?: string;
  status: 'draft' | 'published' | 'unpublished';
  publishedAt?: string;
  updatedAt: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Published posts, newest first. Throws on any non-2xx response. */
export function fetchPosts(): Promise<PostView[]> {
  return getJson<PostView[]>('/api/posts');
}

/** A single published post by slug. Throws on any non-2xx response. */
export function fetchPost(slug: string): Promise<PostView> {
  return getJson<PostView>(`/api/posts/${encodeURIComponent(slug)}`);
}

/* -------------------------------------------------------- pages API client
   `gallery` entries are { ref, caption? } — the shape engine/gallery.ts
   draws from and the API stores; the type is re-exported here so a caller
   of the pages client never has to reach past it. */

export type { GalleryEntry };


/**
 * The pages read model — one shape for public and admin projections.
 * `summary` (<= 300 chars), `image` ('https://…' or 'asset:<token>'),
 * `gallery` (up to 24 { ref, caption? } pictures, each ref held to the
 * same rule as `image`) and `repo` ('owner/name') are OPTIONAL card
 * metadata: authored in a page's front matter, edited in the maintainer
 * console, carried on PageCreated/PageRevised.
 */
export interface PageView {
  slug: string;
  title: string;
  body?: string;
  summary?: string;
  image?: string;
  /** Absent — never [] — when the page has no gallery. */
  gallery?: GalleryEntry[];
  repo?: string;
  status: 'draft' | 'published' | 'unpublished';
  publishedAt?: string;
  updatedAt: string;
}

/** One row of GET /api/pages — published pages only, title asc. */
export interface PageListItem {
  slug: string;
  title: string;
  publishedAt?: string;
  summary?: string;
  image?: string;
  gallery?: GalleryEntry[];
  repo?: string;
}

/** Published pages, title asc. Throws on any non-2xx response. */
export function fetchPages(): Promise<PageListItem[]> {
  return getJson<PageListItem[]>('/api/pages');
}

/**
 * A single published page by slug. Resolves null on 404 so the reading
 * room can say an honest 'page not found'; throws on other failures.
 */
export async function fetchPage(slug: string): Promise<PageView | null> {
  const res = await fetch(`/api/pages/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /api/pages/${slug} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as PageView;
}

/* -------------------------------------------------------------- page cards
   The card model every page block renders from — section rows AND the
   markdown '!page[slug]' blocks resolve through the SAME helper, so an
   unpublished page disappears from both at once (the public endpoint
   404s → null → the block renders nothing). */

export interface PageCard {
  slug: string;
  title: string;
  /** Authored summary, or the page's first body paragraph, truncated. */
  summary: string;
  /** Raw image reference — 'https://…' or 'asset:<token>'; may be absent. */
  image?: string;
  /** 'owner/name' — the repository this page's work lives in, if any. */
  repo?: string;
}

const SUMMARY_FALLBACK_MAX = 160;

/** Drop a leading '---' front-matter block if one ever reaches the client. */
function stripFrontMatter(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return body;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end < 0 ? body : lines.slice(end + 1).join('\n');
}

/** Strip the inline markdown marks so a summary reads as plain prose. */
function plainify(md: string): string {
  return md
    .replace(/!(?:page|repo|image|gallery)\[[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^()\s]*\)/g, '$1')
    .replace(/[*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First real paragraph of a body — headings, lists, quotes, code skipped. */
function firstParagraph(body: string): string {
  const blocks = stripFrontMatter(body).split(/\n\s*\n/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (/^(#|>|-\s|\d+\.\s|```|!page\[|!repo\[|!image\[|!gallery\[)/.test(block)) continue;
    const flat = plainify(block);
    if (flat) return flat;
  }
  return '';
}

/** Truncate on a word boundary, ellipsis only when something was cut. */
export function truncate(s: string, max = SUMMARY_FALLBACK_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '') + '…';
}

/** The card view of a page: authored summary wins, body paragraph fills in. */
export function pageToCard(page: PageView | PageListItem): PageCard {
  const authored = page.summary?.trim() ?? '';
  const body = 'body' in page ? (page.body ?? '') : '';
  return {
    slug: page.slug,
    title: page.title,
    summary: authored || truncate(firstParagraph(body)),
    image: page.image?.trim() || undefined,
    repo: page.repo?.trim() || undefined,
  };
}

/** slug → in-flight/settled resolution; failures evict so a retry can run. */
const cardCache = new Map<string, Promise<PageCard | null>>();

/**
 * Resolve a page block's card. Cached per slug (a section row and three
 * markdown embeds of the same slug share ONE fetch), null for anything
 * the public API will not serve — unknown slug, draft, unpublished.
 */
export function resolvePageCard(slug: string): Promise<PageCard | null> {
  const hit = cardCache.get(slug);
  if (hit) return hit;
  const pending = fetchPage(slug)
    .then((page) => (page === null ? null : pageToCard(page)))
    .catch(() => {
      /* transient (offline, 5xx) — forget it so a later render retries */
      cardCache.delete(slug);
      return null;
    });
  cardCache.set(slug, pending);
  return pending;
}

/* ------------------------------------------------------------ repositories
   GET /api/github/:owner/:repo — the server's cached, timeout-bounded
   proxy. It ALWAYS answers 200 with one of three states, so 'private' is a
   first-class outcome here, not an error: Diego's infra repo is private and
   the widget must say so instead of offering a link that 404s.

   This client mirrors resolvePageCard(): one shared promise per repo, so a
   showcase row, a page room and three markdown embeds of the same
   'owner/name' make exactly ONE request. It NEVER throws — an unreachable
   or not-yet-deployed endpoint degrades to the 'unavailable' state, which
   the widget already knows how to draw. */

/** The reference format, mirrored from the API's validator. */
export const REPO_REF_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export type RepoUnavailableReason = 'rate-limited' | 'timeout' | 'error';

/** Upstream answered: metadata is public and current. */
export interface RepoPublic {
  state: 'public';
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  pushedAt: string;
  homepage: string | null;
}

/** Upstream said 404/403 — private, renamed or gone; we do not guess which. */
export interface RepoPrivate {
  state: 'private';
  fullName: string;
  url: string;
}

/** Nothing was learned this time — network, timeout or rate limit. */
export interface RepoUnavailable {
  state: 'unavailable';
  fullName: string;
  url: string;
  reason: RepoUnavailableReason;
}

export type RepoInfo = RepoPublic | RepoPrivate | RepoUnavailable;

/**
 * A reference that is safe to put in a path. REPO_REF_RE alone is not
 * enough: '.' is in its character class, so '../..' matches it and a
 * browser would resolve '/api/github/../..' away before the request ever
 * left. An all-dots segment is therefore not a reference — GitHub has no
 * such owner or repository anyway. (The API's validator draws the same
 * line; this one exists so a bad value never becomes a request at all.)
 */
export function isRepoRef(ref: string): boolean {
  if (!REPO_REF_RE.test(ref)) return false;
  return ref.split('/').every((seg) => !/^\.+$/.test(seg));
}

/** The canonical page for a validated reference — our own, never upstream's. */
function repoUrl(ref: string): string {
  const cut = ref.indexOf('/');
  const owner = ref.slice(0, cut);
  const name = ref.slice(cut + 1);
  return 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name);
}

function unavailable(fullName: string, url: string, reason: RepoUnavailableReason): RepoUnavailable {
  return { state: 'unavailable', fullName, url, reason };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const REASONS: RepoUnavailableReason[] = ['rate-limited', 'timeout', 'error'];

/**
 * Read the proxy's body defensively: a shape we do not recognise is an
 * 'unavailable', never a throw. The href is ALWAYS our own derived github
 * URL unless the server echoed a github.com URL back — an href is the one
 * field a widget hands to the browser, so it is not taken on trust.
 */
function parseRepo(raw: unknown, ref: string): RepoInfo {
  const url = repoUrl(ref);
  if (typeof raw !== 'object' || raw === null) return unavailable(ref, url, 'error');
  const o = raw as Record<string, unknown>;
  const fullName = asString(o.fullName) ?? ref;
  const echoed = asString(o.url) ?? '';
  const href = echoed.startsWith('https://github.com/') ? echoed : url;
  const state = asString(o.state);
  if (state === 'private') return { state: 'private', fullName, url: href };
  if (state === 'unavailable') {
    const reason = asString(o.reason) as RepoUnavailableReason | null;
    return unavailable(fullName, href, reason && REASONS.includes(reason) ? reason : 'error');
  }
  if (state !== 'public') return unavailable(fullName, href, 'error');
  return {
    state: 'public',
    fullName,
    url: href,
    description: asString(o.description),
    language: asString(o.language),
    stars: asCount(o.stars),
    forks: asCount(o.forks),
    topics: asStringList(o.topics),
    pushedAt: asString(o.pushedAt) ?? '',
    homepage: asString(o.homepage),
  };
}

async function fetchRepo(ref: string): Promise<RepoInfo> {
  const res = await fetch('/api/github/' + ref, { headers: { accept: 'application/json' } });
  /* the contract says 200 always — anything else means the endpoint is not
     there (yet) or the server is unwell: unavailable, not an exception */
  if (!res.ok) return unavailable(ref, repoUrl(ref), 'error');
  return parseRepo(await res.json(), ref);
}

/** 'owner/name' lowercased → in-flight/settled resolution. */
const repoCache = new Map<string, Promise<RepoInfo | null>>();

/**
 * Resolve one repository reference. Cached per lowercased 'owner/name'
 * (every placement shares ONE fetch), null when the reference is not a
 * valid 'owner/name' — a malformed value renders nothing rather than
 * sending unvalidated input at the proxy.
 */
export function resolveRepo(ownerRepo: string): Promise<RepoInfo | null> {
  const ref = ownerRepo.trim();
  if (!isRepoRef(ref)) return Promise.resolve(null);
  const key = ref.toLowerCase();
  const hit = repoCache.get(key);
  if (hit) return hit;
  const pending = fetchRepo(ref).catch(() => {
    /* transient (offline, malformed body) — forget it so a later render
       retries; the caller still gets a drawable state, never a rejection */
    repoCache.delete(key);
    return unavailable(ref, repoUrl(ref), 'error');
  });
  repoCache.set(key, pending);
  return pending;
}

/* --------------------------------------------------------- deploy metadata */

export interface DeployInfo {
  sha: string;
  at: string;
}

export interface MetaInfo {
  commit: string;
  builtAt: string;
  deploys: DeployInfo[];
}

/**
 * /api/meta may 404 while the endpoint ships — this resolves null on ANY
 * failure (network error, non-2xx, malformed body) and never throws.
 */
export async function fetchMeta(): Promise<MetaInfo | null> {
  try {
    const res = await fetch('/api/meta', {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.commit !== 'string' || typeof obj.builtAt !== 'string') {
      return null;
    }
    const deploys: DeployInfo[] = Array.isArray(obj.deploys)
      ? (obj.deploys as unknown[]).flatMap((d): DeployInfo[] => {
          if (typeof d !== 'object' || d === null) return [];
          const row = d as Record<string, unknown>;
          return typeof row.sha === 'string' && typeof row.at === 'string'
            ? [{ sha: row.sha, at: row.at }]
            : [];
        })
      : [];
    return { commit: obj.commit, builtAt: obj.builtAt, deploys };
  } catch {
    return null;
  }
}
