import { Injectable } from '@nestjs/common';
import { StoredEvent } from '../blog/event-store';
import {
  PAGE_CREATED,
  PAGE_PUBLISHED,
  PAGE_REVISED,
  PAGE_UNPUBLISHED,
  PageCreatedData,
  PageGalleryEntry,
  PagePublishedData,
  PageRevisedData,
  PageUnpublishedData,
} from './events';

export type PageStatus = 'draft' | 'published' | 'unpublished';

/** Optional metadata is a non-empty string or nothing at all. */
function presentText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A gallery is a fresh array of usable entries or nothing at all. Entries
 * with no ref are dropped and an empty list becomes an absent key, so an
 * `[]` in the log reads exactly like "this page has no gallery" — the same
 * rule `''` follows for the text fields, one level up. The array is rebuilt
 * rather than borrowed: the read model never aliases event data.
 */
function presentGallery(value: unknown): PageGalleryEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: PageGalleryEntry[] = [];
  for (const item of value) {
    const raw = (item ?? {}) as { ref?: unknown; caption?: unknown };
    const ref = presentText(raw.ref);
    if (ref === undefined) continue;
    const caption = presentText(raw.caption);
    entries.push({ ref, ...(caption !== undefined ? { caption } : {}) });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Revising an optional field to '' removes it rather than blanking it. */
function assign(
  page: PageView,
  key: 'summary' | 'image' | 'repo',
  value: string,
): void {
  const next = presentText(value);
  if (next === undefined) delete page[key];
  else page[key] = next;
}

export interface PageView {
  slug: string;
  title: string;
  body: string;
  /**
   * Card metadata: a short deck for the page's card and an image reference
   * (`https://...` or `asset:<token>`). Absent keys, not empty strings, when
   * the page carries none — the card falls back to the first body paragraph
   * and a monogram placeholder.
   */
  summary?: string;
  image?: string;
  /**
   * The page's picture strip, in authored order, absent (never `[]`) when
   * the page has none — a renderer that sees no key knows there is no grid
   * to draw. Each entry is `{ref, caption?}` with `ref` in the same format
   * as `image`.
   */
  gallery?: PageGalleryEntry[];
  /**
   * `owner/name` of the repository this page is about, absent when it is
   * about none. The reference is all the read model holds: whether that
   * repo is public, private or gone is upstream state the widget resolves
   * through /api/github, never something a replay could contradict.
   */
  repo?: string;
  status: PageStatus;
  /** ISO timestamp of the publish that made the page visible. */
  publishedAt?: string;
  /** ISO timestamp of the latest event applied to this page. */
  updatedAt: string;
}

/**
 * In-memory read model folded from the event stream, mirroring
 * PostsProjection. Rebuildable by construction: it holds no state that a
 * full replay of the log cannot reproduce, so restart = reset() + replay.
 *
 * Lifecycle: Created -> draft, Published -> published, Unpublished ->
 * unpublished (hidden from public reads but kept, history intact),
 * Published again -> republished with a fresh publishedAt. Revised merges
 * `changes` into the page in any status. Every applied event bumps
 * `updatedAt` to the event's `at`. Post and deploy events are unknown types
 * here and pass through untouched.
 *
 * Card metadata (`summary`, `image`, `repo`) and the `gallery` ride along
 * untouched by publish and unpublish: a page that goes dark and comes back
 * keeps the fields its cards and its picture grid render from.
 */
@Injectable()
export class PagesProjection {
  private readonly pages = new Map<string, PageView>();

  apply(event: StoredEvent): void {
    switch (event.type) {
      case PAGE_CREATED: {
        const data = event.data as PageCreatedData;
        const summary = presentText(data.summary);
        const image = presentText(data.image);
        const repo = presentText(data.repo);
        const gallery = presentGallery(data.gallery);
        this.pages.set(data.slug, {
          slug: data.slug,
          title: data.title,
          body: data.body ?? '',
          ...(summary !== undefined ? { summary } : {}),
          ...(image !== undefined ? { image } : {}),
          ...(gallery !== undefined ? { gallery } : {}),
          ...(repo !== undefined ? { repo } : {}),
          status: 'draft',
          updatedAt: event.at,
        });
        break;
      }
      case PAGE_PUBLISHED: {
        const data = event.data as PagePublishedData;
        const page = this.pages.get(data.slug);
        if (page) {
          page.status = 'published';
          page.publishedAt = data.publishedAt ?? event.at;
          page.updatedAt = event.at;
        }
        break;
      }
      case PAGE_REVISED: {
        const data = event.data as PageRevisedData;
        const page = this.pages.get(data.slug);
        if (page) {
          const changes = data.changes ?? {};
          if (changes.title !== undefined) page.title = changes.title;
          if (changes.body !== undefined) page.body = changes.body;
          if (changes.summary !== undefined) {
            assign(page, 'summary', changes.summary);
          }
          if (changes.image !== undefined) {
            assign(page, 'image', changes.image);
          }
          if (changes.repo !== undefined) {
            assign(page, 'repo', changes.repo);
          }
          if (changes.gallery !== undefined) {
            const next = presentGallery(changes.gallery);
            if (next === undefined) delete page.gallery;
            else page.gallery = next;
          }
          page.updatedAt = event.at;
        }
        break;
      }
      case PAGE_UNPUBLISHED: {
        const data = event.data as PageUnpublishedData;
        const page = this.pages.get(data.slug);
        if (page) {
          page.status = 'unpublished';
          page.updatedAt = event.at;
        }
        break;
      }
      default:
        // Unknown event types (posts, deploys, future streams) are ignored.
        break;
    }
  }

  reset(): void {
    this.pages.clear();
  }

  has(slug: string): boolean {
    return this.pages.has(slug);
  }

  /** Any status; undefined when unknown. */
  get(slug: string): PageView | undefined {
    return this.pages.get(slug);
  }

  /** Every page regardless of status, most recently updated first. */
  listAll(): PageView[] {
    return [...this.pages.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  /** Published pages only, title ascending. */
  listPublished(): PageView[] {
    return [...this.pages.values()]
      .filter((page) => page.status === 'published')
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  getPublished(slug: string): PageView | undefined {
    const page = this.pages.get(slug);
    return page?.status === 'published' ? page : undefined;
  }
}
