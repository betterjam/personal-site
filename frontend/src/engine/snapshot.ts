/**
 * THE SNAPSHOT — what the repository published, bundled at build time.
 *
 * The site's copy lives on published pages and is read at runtime from
 * /api/pages/<slug>. That API is meant to be switched OFF: the public
 * control plane at control.diegopalominos.dev exists so a visitor can
 * stop the infrastructure like turning off a light. So an unreachable API
 * must never empty the site — it must only make it less live.
 *
 * This module is the floor. The page-snapshot plugin in vite.config.ts
 * parses every content/pages/*.md at build time with the SERVER's own
 * front-matter semantics (src/build/pageSeed.ts) and hands the result over
 * as `virtual:page-snapshot`; here it is lifted into the very shapes the
 * API serves — PageView and PageListItem — so a caller cannot tell the two
 * apart by inspection, only by the `origin` the resolver reports.
 *
 * HONESTY. A snapshot page is stamped with the BUILD time, not with a
 * publication time it does not know, and every surface that renders one
 * says where it came from (engine/asleep.ts owns those words). It is the
 * last published snapshot, never live data.
 *
 * Cost: an eagerly bundled, already-parsed array — no fetch, no top-level
 * await, no Markdown parsing in the browser, no work at module init beyond
 * building one Map.
 */
import PAGES from 'virtual:page-snapshot';
import type { SnapshotPage } from '../build/pageSeed';
import type { PageListItem, PageView } from './data';

/** When this snapshot was taken — the build stamp, and nothing fancier. */
export const SNAPSHOT_AT: string = __BUILD_INFO__.builtAt;

const BY_SLUG = new Map<string, SnapshotPage>(PAGES.map((page) => [page.slug, page]));

/**
 * The API's PageView for a bundled page. `status` is 'published' because
 * that is exactly what the seeder does with these files (PageCreated +
 * PagePublished); the two timestamps are the build stamp, which is the
 * only date this side honestly knows.
 */
function toView(page: SnapshotPage): PageView {
  return {
    slug: page.slug,
    title: page.title,
    body: page.body,
    ...(page.summary !== undefined ? { summary: page.summary } : {}),
    ...(page.image !== undefined ? { image: page.image } : {}),
    ...(page.repo !== undefined ? { repo: page.repo } : {}),
    ...(page.gallery !== undefined ? { gallery: page.gallery } : {}),
    status: 'published',
    publishedAt: SNAPSHOT_AT,
    updatedAt: SNAPSHOT_AT,
  };
}

/** The bundled page for a slug, or null when the repo published no such page. */
export function snapshotPage(slug: string): PageView | null {
  const page = BY_SLUG.get(slug);
  return page ? toView(page) : null;
}

/**
 * Every bundled page as an index row, TITLE ASCENDING — the order
 * GET /api/pages answers in, so the footer's page list reads the same
 * whether it came from the API or from here.
 */
export function snapshotPageList(): PageListItem[] {
  return PAGES.map((page): PageListItem => {
    const view = toView(page);
    return {
      slug: view.slug,
      title: view.title,
      ...(view.publishedAt !== undefined ? { publishedAt: view.publishedAt } : {}),
      ...(view.summary !== undefined ? { summary: view.summary } : {}),
      ...(view.image !== undefined ? { image: view.image } : {}),
      ...(view.gallery !== undefined ? { gallery: view.gallery } : {}),
      ...(view.repo !== undefined ? { repo: view.repo } : {}),
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}
