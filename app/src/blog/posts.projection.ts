import { Injectable } from '@nestjs/common';
import { StoredEvent } from './event-store';
import {
  POST_DRAFTED,
  POST_PUBLISHED,
  POST_REVISED,
  POST_UNPUBLISHED,
  PostDraftedData,
  PostPublishedData,
  PostRevisedData,
  PostUnpublishedData,
} from './events';

export type PostStatus = 'draft' | 'published' | 'unpublished';

export interface PostView {
  slug: string;
  title: string;
  deck: string;
  tags: string[];
  body?: string;
  status: PostStatus;
  /** ISO timestamp of the publish that made the post visible. */
  publishedAt?: string;
  /** ISO timestamp of the latest event applied to this post. */
  updatedAt: string;
}

/**
 * In-memory read model folded from the event stream.
 * Rebuildable by construction: it holds no state that a full replay of
 * the log cannot reproduce, so restart = reset() + replay.
 *
 * Lifecycle: Drafted -> draft, Published -> published, Unpublished ->
 * unpublished (hidden from public reads but kept, history intact),
 * Published again -> republished with a fresh publishedAt. Revised merges
 * `changes` into the post in any status. Every applied event bumps
 * `updatedAt` to the event's `at`.
 */
@Injectable()
export class PostsProjection {
  private readonly posts = new Map<string, PostView>();

  apply(event: StoredEvent): void {
    switch (event.type) {
      case POST_DRAFTED: {
        const data = event.data as PostDraftedData;
        this.posts.set(data.slug, {
          slug: data.slug,
          title: data.title,
          deck: data.deck,
          tags: data.tags ?? [],
          ...(data.body !== undefined ? { body: data.body } : {}),
          status: 'draft',
          updatedAt: event.at,
        });
        break;
      }
      case POST_PUBLISHED: {
        const data = event.data as PostPublishedData;
        const post = this.posts.get(data.slug);
        if (post) {
          post.status = 'published';
          post.publishedAt = data.publishedAt ?? event.at;
          post.updatedAt = event.at;
        }
        break;
      }
      case POST_REVISED: {
        const data = event.data as PostRevisedData;
        const post = this.posts.get(data.slug);
        if (post) {
          const changes = data.changes ?? {};
          if (changes.title !== undefined) post.title = changes.title;
          if (changes.deck !== undefined) post.deck = changes.deck;
          if (changes.tags !== undefined) post.tags = changes.tags;
          if (changes.body !== undefined) post.body = changes.body;
          post.updatedAt = event.at;
        }
        break;
      }
      case POST_UNPUBLISHED: {
        const data = event.data as PostUnpublishedData;
        const post = this.posts.get(data.slug);
        if (post) {
          post.status = 'unpublished';
          post.updatedAt = event.at;
        }
        break;
      }
      default:
        // Unknown event types are ignored so old builds can replay newer logs.
        break;
    }
  }

  reset(): void {
    this.posts.clear();
  }

  has(slug: string): boolean {
    return this.posts.has(slug);
  }

  /** Any status; undefined when unknown. */
  get(slug: string): PostView | undefined {
    return this.posts.get(slug);
  }

  /** Every post regardless of status, most recently updated first. */
  listAll(): PostView[] {
    return [...this.posts.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  listPublished(): PostView[] {
    return [...this.posts.values()]
      .filter((post) => post.status === 'published')
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  }

  getPublished(slug: string): PostView | undefined {
    const post = this.posts.get(slug);
    return post?.status === 'published' ? post : undefined;
  }
}
