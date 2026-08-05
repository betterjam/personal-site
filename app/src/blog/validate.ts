import { BadRequestException } from '@nestjs/common';
import { PostRevisionChanges } from './events';

export interface NewPostInput {
  title: string;
  deck: string;
  tags: string[];
  body?: string;
  /** true = append PostDrafted only; default publishes immediately. */
  draft: boolean;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new BadRequestException({ error: 'tags must be an array of strings' });
  }
  return value as string[];
}

function parseBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'body must be a string' });
  }
  return value;
}

/** Validates a POST /api/posts payload; throws 400 on anything malformed. */
export function validateNewPost(payload: unknown): NewPostInput {
  const raw = (payload ?? {}) as Record<string, unknown>;

  const { title, deck } = raw;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new BadRequestException({ error: 'title must be a non-empty string' });
  }
  if (typeof deck !== 'string' || deck.trim() === '') {
    throw new BadRequestException({ error: 'deck must be a non-empty string' });
  }

  const tags = raw.tags !== undefined ? parseTags(raw.tags) : [];
  const body = raw.body !== undefined ? parseBody(raw.body) : undefined;

  let draft = false;
  if (raw.draft !== undefined) {
    if (typeof raw.draft !== 'boolean') {
      throw new BadRequestException({ error: 'draft must be a boolean' });
    }
    draft = raw.draft;
  }

  return {
    title: title.trim(),
    deck: deck.trim(),
    tags,
    ...(body !== undefined ? { body } : {}),
    draft,
  };
}

/**
 * Validates a PATCH /api/posts/:slug payload into PostRevised changes;
 * throws 400 when malformed or when no recognized field is present.
 */
export function validateRevision(payload: unknown): PostRevisionChanges {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const changes: PostRevisionChanges = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
      throw new BadRequestException({
        error: 'title must be a non-empty string',
      });
    }
    changes.title = raw.title.trim();
  }
  if (raw.deck !== undefined) {
    if (typeof raw.deck !== 'string' || raw.deck.trim() === '') {
      throw new BadRequestException({
        error: 'deck must be a non-empty string',
      });
    }
    changes.deck = raw.deck.trim();
  }
  if (raw.tags !== undefined) {
    changes.tags = parseTags(raw.tags);
  }
  if (raw.body !== undefined) {
    changes.body = parseBody(raw.body);
  }

  if (Object.keys(changes).length === 0) {
    throw new BadRequestException({
      error: 'at least one of title, deck, tags, body is required',
    });
  }
  return changes;
}
