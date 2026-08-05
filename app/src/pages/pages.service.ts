import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EVENT_STORE, EventStore, StoredEvent } from '../blog/event-store';
import { PostsProjection } from '../blog/posts.projection';
import { slugify } from '../blog/slug.util';
import { isEnoent } from '../common/errors';
import { pagesDir } from '../config/paths';
import {
  PAGE_CREATED,
  PAGE_EVENT_TYPES,
  PAGE_PUBLISHED,
  PAGE_REVISED,
  PAGE_UNPUBLISHED,
  PageGalleryEntry,
  PageRevisionChanges,
} from './events';
import { PageFrontMatter, parseFrontMatter } from './front-matter';
import { PagesProjection, PageView } from './pages.projection';
import {
  GALLERY_MAX_ENTRIES,
  isValidPageImage,
  isValidPageRepo,
  isValidPageSummary,
  NewPageInput,
} from './validate';

/**
 * Public list item: the read model trimmed to what an index needs — which,
 * since page blocks render cards straight from this list, now includes the
 * card metadata. Absent keys when the page carries none.
 */
export interface PageSummary {
  slug: string;
  title: string;
  /** ISO timestamp; always set on a published page. */
  publishedAt?: string;
  summary?: string;
  image?: string;
  /** `owner/name`; a card that has it can hang a repo widget under itself. */
  repo?: string;
  /** The page's picture strip; absent when it has none. */
  gallery?: PageGalleryEntry[];
}

/**
 * Title/body split for one authored seed file. A '# Heading' first line
 * becomes the title (that line and one following blank line leave the
 * body); otherwise the filename is humanized ('guitar-shelf' -> 'Guitar
 * Shelf') and the whole file is the body. The body is trimmed either way.
 * Front matter is stripped BEFORE this runs, so a heading pushed down by a
 * metadata block is still the page's title.
 */
function splitSeedFile(slug: string, raw: string): { title: string; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.startsWith('# ')) {
    const title = lines[0].slice(2).trim();
    let rest = lines.slice(1);
    if (rest[0]?.trim() === '') rest = rest.slice(1);
    return { title, body: rest.join('\n').trim() };
  }
  return { title: humanize(slug), body: raw.trim() };
}

/** 'working-with-me' -> 'Working With Me'. */
function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

@Injectable()
export class PagesService implements OnModuleInit {
  private readonly logger = new Logger(PagesService.name);

  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    private readonly projection: PagesProjection,
    // Posts and pages share one slug namespace (routes stay unambiguous),
    // so create checks both projections before appending.
    private readonly posts: PostsProjection,
  ) {}

  /**
   * Boot = full replay of the log into the projection, then a PER-SLUG
   * seed pass: each PAGES_DIR/*.md whose slug has ZERO page events in the
   * log is appended as PageCreated + PagePublished. The gate is per slug,
   * not per store — a new .md file dropped in later seeds on the next boot
   * while every slug with ANY page history (created, revised, unpublished,
   * anything) is left strictly alone: one maintainer edit permanently
   * detaches a page from its file. Posts and deploys ride the same log and
   * never influence the gate.
   */
  async onModuleInit(): Promise<void> {
    const { replayed, pageSlugs } = await this.replay();
    this.logger.log(`Replayed ${replayed} event(s) into pages projection`);
    await this.seedFromPagesDir(pageSlugs);
  }

  /** Public: published pages only, title ascending, summary shape. */
  listPublished(): PageSummary[] {
    return this.projection.listPublished().map((page) => ({
      slug: page.slug,
      title: page.title,
      publishedAt: page.publishedAt,
      ...(page.summary !== undefined ? { summary: page.summary } : {}),
      ...(page.image !== undefined ? { image: page.image } : {}),
      ...(page.repo !== undefined ? { repo: page.repo } : {}),
      ...(page.gallery !== undefined ? { gallery: page.gallery } : {}),
    }));
  }

  getPublished(slug: string): PageView {
    const page = this.projection.getPublished(slug);
    if (!page) {
      throw new NotFoundException({ error: `unknown page: ${slug}` });
    }
    return page;
  }

  /** Admin: every page regardless of status, most recently updated first. */
  listAll(): PageView[] {
    return this.projection.listAll();
  }

  /** Admin: one page in any status; 404 when the slug is unknown. */
  getAny(slug: string): PageView {
    const page = this.projection.get(slug);
    if (!page) {
      throw new NotFoundException({ error: `unknown page: ${slug}` });
    }
    return page;
  }

  /** Admin: the slug's raw events in seq order; 404 when the slug is unknown. */
  async getEvents(slug: string): Promise<StoredEvent[]> {
    this.getAny(slug); // 404 gate
    const events: StoredEvent[] = [];
    for await (const event of this.store.readAll()) {
      const data = event.data as { slug?: unknown } | null | undefined;
      if (data && data.slug === slug) {
        events.push(event);
      }
    }
    return events;
  }

  async createPage(input: NewPageInput): Promise<PageView> {
    const slug = slugify(input.title);
    if (slug === '') {
      throw new BadRequestException({
        error: 'title must contain at least one alphanumeric character',
      });
    }
    if (this.projection.has(slug) || this.posts.has(slug)) {
      throw new ConflictException({ error: `slug already in use: ${slug}` });
    }

    const now = new Date().toISOString();
    await this.appendAndApply(
      PAGE_CREATED,
      {
        slug,
        title: input.title,
        body: input.body,
        // Optional metadata stays out of the event unless it is really there.
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.gallery !== undefined ? { gallery: input.gallery } : {}),
      },
      now,
    );
    if (!input.draft) {
      await this.appendAndApply(PAGE_PUBLISHED, { slug, publishedAt: now }, now);
    }
    return this.getAny(slug);
  }

  /** Merges changes into the page via a PageRevised event; any status. */
  async revisePage(
    slug: string,
    changes: PageRevisionChanges,
  ): Promise<PageView> {
    this.getAny(slug); // 404 gate
    await this.appendAndApply(PAGE_REVISED, { slug, changes });
    return this.getAny(slug);
  }

  /** Idempotent: an already-published page returns as-is with no new event. */
  async publishPage(slug: string): Promise<PageView> {
    const page = this.getAny(slug);
    if (page.status === 'published') {
      return page;
    }
    const now = new Date().toISOString();
    await this.appendAndApply(PAGE_PUBLISHED, { slug, publishedAt: now }, now);
    return this.getAny(slug);
  }

  /** Idempotent: a page that is not published returns as-is with no new event. */
  async unpublishPage(slug: string): Promise<PageView> {
    const page = this.getAny(slug);
    if (page.status !== 'published') {
      return page;
    }
    const now = new Date().toISOString();
    await this.appendAndApply(PAGE_UNPUBLISHED, { slug, at: now }, now);
    return this.getAny(slug);
  }

  /**
   * Full replay into the projection. Also collects the slug of every page
   * event seen — the seeding gate. Raw events are the authority here, not
   * the projection: a stray page event whose slug the projection cannot
   * fold (say, a revision without a creation) still marks its slug as
   * having history, and history means hands off.
   */
  private async replay(): Promise<{ replayed: number; pageSlugs: Set<string> }> {
    this.projection.reset();
    let replayed = 0;
    const pageSlugs = new Set<string>();
    for await (const event of this.store.readAll()) {
      this.projection.apply(event);
      replayed += 1;
      if (PAGE_EVENT_TYPES.has(event.type)) {
        const data = event.data as { slug?: unknown } | null | undefined;
        if (data && typeof data.slug === 'string') {
          pageSlugs.add(data.slug);
        }
      }
    }
    return { replayed, pageSlugs };
  }

  /** Every write goes through the store first, then feeds the projection in-process. */
  private async appendAndApply(
    type: string,
    data: unknown,
    at?: string,
  ): Promise<void> {
    const stored = await this.store.append({ type, data, at });
    this.projection.apply(stored);
  }

  /**
   * Seeds the authored Markdown pages in PAGES_DIR (repo default:
   * content/pages) as PageCreated + PagePublished pairs, in filename order
   * so every fresh environment builds an identical log. `existing` is the
   * set of slugs that already have page events; those files are skipped —
   * the file is only ever the FIRST version of a page, never an update.
   * Each file is read front matter first (card metadata out, and out of the
   * body), then title/body. Appends go through appendAndApply, so seeded
   * pages hit the projection exactly like replayed ones and serve without a
   * restart. A missing or empty directory is a quiet no-op: an empty pages
   * list is a real state.
   */
  private async seedFromPagesDir(existing: ReadonlySet<string>): Promise<void> {
    const dir = pagesDir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isEnoent(err)) {
        return;
      }
      throw err;
    }

    const files = names.filter((name) => name.endsWith('.md')).sort();
    let seeded = 0;
    for (const file of files) {
      const slug = file.slice(0, -'.md'.length);
      if (existing.has(slug)) {
        continue;
      }
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const { attributes, body: stripped } = parseFrontMatter(raw);
      const { title, body } = splitSeedFile(slug, stripped);
      const meta = this.seedMeta(slug, attributes);
      const now = new Date().toISOString();
      await this.appendAndApply(
        PAGE_CREATED,
        { slug, title, body, ...meta },
        now,
      );
      await this.appendAndApply(PAGE_PUBLISHED, { slug, publishedAt: now }, now);
      seeded += 1;
    }
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} page(s) from content/pages`);
    }
  }

  /**
   * Front matter values held to the same rules as the API's: an over-long
   * summary, an image that is neither `https://` nor `asset:<token>`, or a
   * repo that is not `owner/name` is dropped with a warning rather than
   * thrown. A boot must not die on one bad line in one authored file — the
   * page still seeds, just without the offending field, and the card falls
   * back. The gallery follows the same rule per ENTRY: a bad reference
   * costs its own picture, not the other twenty-three, and a list longer
   * than the cap keeps its first GALLERY_MAX_ENTRIES entries.
   */
  private seedMeta(slug: string, attributes: PageFrontMatter): PageFrontMatter {
    const meta: PageFrontMatter = {};
    if (attributes.summary !== undefined) {
      if (isValidPageSummary(attributes.summary)) {
        meta.summary = attributes.summary;
      } else {
        this.logger.warn(
          `Ignoring over-long summary in front matter of ${slug}.md`,
        );
      }
    }
    if (attributes.image !== undefined) {
      if (isValidPageImage(attributes.image)) {
        meta.image = attributes.image;
      } else {
        this.logger.warn(
          `Ignoring unsupported image "${attributes.image}" in front matter of ${slug}.md`,
        );
      }
    }
    if (attributes.repo !== undefined) {
      if (isValidPageRepo(attributes.repo)) {
        meta.repo = attributes.repo;
      } else {
        this.logger.warn(
          `Ignoring malformed repo "${attributes.repo}" in front matter of ${slug}.md`,
        );
      }
    }
    if (attributes.gallery !== undefined) {
      const gallery = this.seedGallery(slug, attributes.gallery);
      if (gallery.length > 0) {
        meta.gallery = gallery;
      }
    }
    return meta;
  }

  /** Per-entry gate for `gallery:`; see seedMeta for why nothing throws. */
  private seedGallery(
    slug: string,
    entries: readonly PageGalleryEntry[],
  ): PageGalleryEntry[] {
    const kept = entries.filter((entry) => {
      if (isValidPageImage(entry.ref)) {
        return true;
      }
      this.logger.warn(
        `Ignoring unsupported gallery ref "${entry.ref}" in front matter of ${slug}.md`,
      );
      return false;
    });
    if (kept.length > GALLERY_MAX_ENTRIES) {
      const dropped = kept.length - GALLERY_MAX_ENTRIES;
      this.logger.warn(
        `Ignoring ${dropped} gallery entry(ies) past the ` +
          `${GALLERY_MAX_ENTRIES}-entry cap in front matter of ${slug}.md`,
      );
    }
    return kept.slice(0, GALLERY_MAX_ENTRIES);
  }
}
