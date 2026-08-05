export const POST_DRAFTED = 'PostDrafted';
export const POST_PUBLISHED = 'PostPublished';
export const POST_REVISED = 'PostRevised';
export const POST_UNPUBLISHED = 'PostUnpublished';

export interface PostDraftedData {
  slug: string;
  title: string;
  deck: string;
  tags: string[];
  body?: string;
}

export interface PostPublishedData {
  slug: string;
  /** ISO timestamp. */
  publishedAt: string;
}

/** Partial update; only the present keys change on the post. */
export interface PostRevisionChanges {
  title?: string;
  deck?: string;
  tags?: string[];
  body?: string;
}

export interface PostRevisedData {
  slug: string;
  changes: PostRevisionChanges;
}

export interface PostUnpublishedData {
  slug: string;
  /** ISO timestamp. */
  at: string;
}
