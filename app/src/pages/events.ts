/**
 * Page events share the blog's append-only log; the event `type` is the
 * namespace that keeps the streams apart. The posts projection ignores page
 * events (unknown types to it) and the pages projection ignores post and
 * deploy events, so each read model folds only its own slice of the log.
 */
export const PAGE_CREATED = 'PageCreated';
export const PAGE_REVISED = 'PageRevised';
export const PAGE_PUBLISHED = 'PagePublished';
export const PAGE_UNPUBLISHED = 'PageUnpublished';

/**
 * Every page event type. The boot-time seeder collects the slugs of events
 * in this set during replay and skips those files: posts and deploys ride
 * the same log, so "the store is empty" is the wrong question — "does this
 * SLUG have any page events" is the per-file gate.
 */
export const PAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  PAGE_CREATED,
  PAGE_REVISED,
  PAGE_PUBLISHED,
  PAGE_UNPUBLISHED,
]);

/**
 * One picture in a page's gallery: a reference in the same format as
 * `image` (an `https://` URL or an `asset:<token>`) plus an optional
 * caption. The caption is the page's words about the shot, so it travels
 * with the reference rather than being looked up from the asset.
 */
export interface PageGalleryEntry {
  ref: string;
  /** Absent, never an empty string, when the shot speaks for itself. */
  caption?: string;
}

export interface PageCreatedData {
  slug: string;
  title: string;
  body: string;
  /**
   * Card metadata, all optional and all omitted from the event when the
   * page has none. `summary` is at most 300 characters; `image` is either an
   * `https://` URL or an `asset:<token>` reference to an image bundled with
   * the frontend. They belong to the page, not to whoever renders it: one
   * page block on the home page and one `!page[slug]` embed inside another
   * page read the same fields.
   */
  summary?: string;
  image?: string;
  /**
   * The page's screenshots, in the order they should be shown: at most 24
   * entries, each ref held to the same format as `image`. Omitted from the
   * event when the page has none — an empty array is never written.
   */
  gallery?: PageGalleryEntry[];
  /**
   * `owner/name` of the repository this page is about. The page carries the
   * REFERENCE only — never the repo's stars, description or visibility,
   * which are upstream state fetched through /api/github and cached there.
   * A repo that is private (or renamed, or deleted) changes nothing in the
   * log.
   */
  repo?: string;
}

/** Partial update; only the present keys change on the page. */
export interface PageRevisionChanges {
  title?: string;
  body?: string;
  /** Empty string clears the field; see PageCreatedData for the formats. */
  summary?: string;
  image?: string;
  repo?: string;
  /** The whole strip, replaced; an EMPTY array clears the gallery. */
  gallery?: PageGalleryEntry[];
}

export interface PageRevisedData {
  slug: string;
  changes: PageRevisionChanges;
}

export interface PagePublishedData {
  slug: string;
  /** ISO timestamp. */
  publishedAt: string;
}

export interface PageUnpublishedData {
  slug: string;
  /** ISO timestamp. */
  at: string;
}
