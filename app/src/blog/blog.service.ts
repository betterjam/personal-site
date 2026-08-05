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
import { isEnoent } from '../common/errors';
import { contentDir } from '../config/paths';
import { EVENT_STORE, EventStore, StoredEvent } from './event-store';
import {
  POST_DRAFTED,
  POST_PUBLISHED,
  POST_REVISED,
  POST_UNPUBLISHED,
  PostRevisionChanges,
} from './events';
import { PostsProjection, PostView } from './posts.projection';
import { slugify } from './slug.util';
import { NewPostInput } from './validate';

interface SeedItem {
  title?: string;
  deck?: string;
  tags?: string[];
  date?: string;
}

@Injectable()
export class BlogService implements OnModuleInit {
  private readonly logger = new Logger(BlogService.name);

  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    private readonly projection: PostsProjection,
  ) {}

  /** Boot = full replay of the log into the projection; seed only an empty store. */
  async onModuleInit(): Promise<void> {
    const replayed = await this.replay();
    this.logger.log(`Replayed ${replayed} event(s) into posts projection`);
    if (replayed === 0) {
      await this.seedFromContent();
    }
  }

  listPublished(): PostView[] {
    return this.projection.listPublished();
  }

  getPublished(slug: string): PostView {
    const post = this.projection.getPublished(slug);
    if (!post) {
      throw new NotFoundException({ error: `unknown post: ${slug}` });
    }
    return post;
  }

  /** Admin: every post regardless of status, most recently updated first. */
  listAll(): PostView[] {
    return this.projection.listAll();
  }

  /** Admin: one post in any status; 404 when the slug is unknown. */
  getAny(slug: string): PostView {
    const post = this.projection.get(slug);
    if (!post) {
      throw new NotFoundException({ error: `unknown post: ${slug}` });
    }
    return post;
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

  async createPost(input: NewPostInput): Promise<PostView> {
    const slug = slugify(input.title);
    if (slug === '') {
      throw new BadRequestException({
        error: 'title must contain at least one alphanumeric character',
      });
    }
    if (this.projection.has(slug)) {
      throw new ConflictException({ error: `post already exists: ${slug}` });
    }

    const now = new Date().toISOString();
    await this.appendAndApply(
      POST_DRAFTED,
      {
        slug,
        title: input.title,
        deck: input.deck,
        tags: input.tags,
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
      now,
    );
    if (!input.draft) {
      await this.appendAndApply(POST_PUBLISHED, { slug, publishedAt: now }, now);
    }
    return this.getAny(slug);
  }

  /** Merges changes into the post via a PostRevised event; any status. */
  async revisePost(
    slug: string,
    changes: PostRevisionChanges,
  ): Promise<PostView> {
    this.getAny(slug); // 404 gate
    await this.appendAndApply(POST_REVISED, { slug, changes });
    return this.getAny(slug);
  }

  /** Idempotent: an already-published post returns as-is with no new event. */
  async publishPost(slug: string): Promise<PostView> {
    const post = this.getAny(slug);
    if (post.status === 'published') {
      return post;
    }
    const now = new Date().toISOString();
    await this.appendAndApply(POST_PUBLISHED, { slug, publishedAt: now }, now);
    return this.getAny(slug);
  }

  /** Idempotent: a post that is not published returns as-is with no new event. */
  async unpublishPost(slug: string): Promise<PostView> {
    const post = this.getAny(slug);
    if (post.status !== 'published') {
      return post;
    }
    const now = new Date().toISOString();
    await this.appendAndApply(POST_UNPUBLISHED, { slug, at: now }, now);
    return this.getAny(slug);
  }

  private async replay(): Promise<number> {
    this.projection.reset();
    let count = 0;
    for await (const event of this.store.readAll()) {
      this.projection.apply(event);
      count += 1;
    }
    return count;
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

  private async seedFromContent(): Promise<void> {
    const file = path.join(contentDir(), 'content.json');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) {
        this.logger.warn(`No content.json at ${file}; skipping blog seed`);
        return;
      }
      throw err;
    }

    const content = JSON.parse(raw) as {
      sections?: Array<{ id?: string; items?: SeedItem[] }>;
    };
    const items =
      content.sections?.find((section) => section.id === 'blog')?.items ?? [];

    let seeded = 0;
    for (const item of items) {
      if (!item.title) continue;
      const slug = slugify(item.title);
      if (slug === '' || this.projection.has(slug)) continue;
      const publishedAt = item.date
        ? new Date(item.date).toISOString()
        : new Date().toISOString();
      await this.appendAndApply(
        POST_DRAFTED,
        { slug, title: item.title, deck: item.deck ?? '', tags: item.tags ?? [] },
        publishedAt,
      );
      await this.appendAndApply(
        POST_PUBLISHED,
        { slug, publishedAt },
        publishedAt,
      );
      seeded += 1;
    }
    this.logger.log(`Seeded ${seeded} post(s) from content.json`);
  }
}
