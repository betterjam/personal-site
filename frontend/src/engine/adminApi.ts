/**
 * Admin API client for the maintainer console (#/maintain).
 *
 * Every call carries the admin token as the x-admin-token header — the
 * token NEVER appears in a URL and is never logged. Non-2xx responses
 * throw ApiError with the HTTP status so the console can tell 401 (wrong
 * token), 503 (admin disabled — no ADMIN_TOKEN on the server), 409
 * (duplicate slug) and 400 (invalid input) apart.
 */
import type { GalleryEntry, PageView, PostView } from './data';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** One raw event from the append-only store, scoped to a slug — the same
    shape for post events and page events (projections filter by type). */
export interface StoreEventView {
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface NewPostInput {
  title: string;
  deck: string;
  tags?: string[];
  body?: string;
  /** true → PostDrafted only (status 'draft'); absent → Drafted+Published. */
  draft?: boolean;
}

export interface PostChanges {
  title?: string;
  deck?: string;
  tags?: string[];
  body?: string;
}

async function request<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-admin-token': token,
  };
  const opts: RequestInit = { method: init?.method ?? 'GET', headers };
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let message = res.statusText || 'request failed';
    try {
      const raw: unknown = await res.json();
      if (raw && typeof raw === 'object') {
        /* Nest errors carry 'message'; the validators throw '{ error }' */
        const rec = raw as Record<string, unknown>;
        const m = rec.message ?? rec.error;
        if (typeof m === 'string') message = m;
        else if (Array.isArray(m) && m.every((x): x is string => typeof x === 'string')) {
          message = m.join('; ');
        }
      }
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

function slugPath(slug: string): string {
  return encodeURIComponent(slug);
}

/** ALL posts, any status, updatedAt desc. Doubles as the token check. */
export function adminFetchPosts(token: string): Promise<PostView[]> {
  return request<PostView[]>(token, '/api/admin/posts');
}

/** One post, any status (includes body). */
export function adminFetchPost(token: string, slug: string): Promise<PostView> {
  return request<PostView>(token, `/api/admin/posts/${slugPath(slug)}`);
}

/** The slug's raw events, seq asc. */
export function adminFetchEvents(token: string, slug: string): Promise<StoreEventView[]> {
  return request<StoreEventView[]>(token, `/api/admin/posts/${slugPath(slug)}/events`);
}

/** 201 → the created post. 409 duplicate slug, 400 invalid. */
export function adminCreatePost(token: string, input: NewPostInput): Promise<PostView> {
  return request<PostView>(token, '/api/posts', { method: 'POST', body: input });
}

/** PostRevised with only the changed fields. 400 empty changes. */
export function adminRevisePost(
  token: string,
  slug: string,
  changes: PostChanges,
): Promise<PostView> {
  return request<PostView>(token, `/api/posts/${slugPath(slug)}`, {
    method: 'PATCH',
    body: changes,
  });
}

/** Idempotent — already-published returns 200 with no new event. */
export function adminPublishPost(token: string, slug: string): Promise<PostView> {
  return request<PostView>(token, `/api/posts/${slugPath(slug)}/publish`, { method: 'POST' });
}

/** Idempotent the same way. */
export function adminUnpublishPost(token: string, slug: string): Promise<PostView> {
  return request<PostView>(token, `/api/posts/${slugPath(slug)}/unpublish`, { method: 'POST' });
}

/* ------------------------------------------------------------------ pages
   The pages contract mirrors posts exactly: same guard, same header, same
   status codes. Slugs share ONE namespace with posts (409 across both). */

export interface NewPageInput {
  title: string;
  body: string;
  /** Card copy, <= 300 chars — 400 from the API when it is longer. */
  summary?: string;
  /** 'https://…' or 'asset:<token>' — 400 from the API on anything else. */
  image?: string;
  /** Up to 24 { ref, caption? } pictures; each ref follows the image rule. */
  gallery?: GalleryEntry[];
  /** 'owner/name' — 400 from the API on anything else. */
  repo?: string;
  /** true → PageCreated only (status 'draft'); absent → Created+Published. */
  draft?: boolean;
}

/**
 * Only the changed fields travel; '' CLEARS summary / image / repo, and an
 * EMPTY ARRAY clears the gallery (the whole strip is replaced, never
 * merged — a gallery is an ordered list, so a partial update would have no
 * meaning).
 */
export interface PageChanges {
  title?: string;
  body?: string;
  summary?: string;
  image?: string;
  gallery?: GalleryEntry[];
  repo?: string;
}

/** ALL pages, any status, updatedAt desc. */
export function adminFetchPages(token: string): Promise<PageView[]> {
  return request<PageView[]>(token, '/api/admin/pages');
}

/** One page, any status (includes body). */
export function adminFetchPage(token: string, slug: string): Promise<PageView> {
  return request<PageView>(token, `/api/admin/pages/${slugPath(slug)}`);
}

/** The slug's raw page events, seq asc. */
export function adminFetchPageEvents(token: string, slug: string): Promise<StoreEventView[]> {
  return request<StoreEventView[]>(token, `/api/admin/pages/${slugPath(slug)}/events`);
}

/** 201 → the created page. 409 duplicate slug (pages AND posts), 400 invalid. */
export function adminCreatePage(token: string, input: NewPageInput): Promise<PageView> {
  return request<PageView>(token, '/api/pages', { method: 'POST', body: input });
}

/** PageRevised with only the changed fields. 400 empty changes. */
export function adminRevisePage(
  token: string,
  slug: string,
  changes: PageChanges,
): Promise<PageView> {
  return request<PageView>(token, `/api/pages/${slugPath(slug)}`, {
    method: 'PATCH',
    body: changes,
  });
}

/** Idempotent — already-published returns 200 with no new event. */
export function adminPublishPage(token: string, slug: string): Promise<PageView> {
  return request<PageView>(token, `/api/pages/${slugPath(slug)}/publish`, { method: 'POST' });
}

/** Idempotent the same way. */
export function adminUnpublishPage(token: string, slug: string): Promise<PageView> {
  return request<PageView>(token, `/api/pages/${slugPath(slug)}/unpublish`, { method: 'POST' });
}
