import { BadRequestException } from '@nestjs/common';
import { isValidRepoRef } from '../common/repo-ref';
import { PageGalleryEntry, PageRevisionChanges } from './events';

export interface NewPageInput {
  title: string;
  body: string;
  /** Optional card metadata; omitted when the payload carries none. */
  summary?: string;
  image?: string;
  /** Optional `owner/name` repository reference. */
  repo?: string;
  /** Optional picture strip; omitted when the payload carries none. */
  gallery?: PageGalleryEntry[];
  /** true = append PageCreated only; default publishes immediately. */
  draft: boolean;
}

/** A card summary is a card, not the page: hard cap, no exceptions. */
export const SUMMARY_MAX_LENGTH = 300;

/** A gallery is a strip, not an archive: hard cap, no exceptions. */
export const GALLERY_MAX_ENTRIES = 24;

/**
 * `asset:<token>` names an image bundled with the frontend build. A token
 * is either a bare name (`maintainer`) or one qualified by its folder
 * (`eleva-app/org-chart-editor`) — the two forms the frontend's asset
 * registry hands out. Exactly one slash: no traversal, no deeper paths.
 */
const ASSET_IMAGE = /^asset:[a-z0-9-]+(?:\/[a-z0-9-]+)?$/;

/**
 * Remote images must be https. Everything else — `http://`, `data:`,
 * `javascript:`, protocol-relative `//host`, bare paths — is rejected here
 * rather than in the renderer, so no unsafe URL ever reaches the log.
 */
const HTTPS_IMAGE = /^https:\/\/[^\s<>"']+$/;

/** Length gate, shared with the seeder's front matter path. */
export function isValidPageSummary(value: string): boolean {
  return value.length <= SUMMARY_MAX_LENGTH;
}

/** Format gate, shared with the seeder's front matter path. */
export function isValidPageImage(value: string): boolean {
  return ASSET_IMAGE.test(value) || HTTPS_IMAGE.test(value);
}

/**
 * Format gate for `repo`, shared with the seeder's front matter path AND
 * with the proxy route's params — one regex, so a reference a page can hold
 * is exactly a reference the proxy will fetch.
 */
export function isValidPageRepo(value: string): boolean {
  return isValidRepoRef(value);
}

function parseBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'body must be a string' });
  }
  return value;
}

/** Trimmed summary; '' is legal and means "no summary" (clears on revise). */
function parseSummary(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'summary must be a string' });
  }
  const summary = value.trim();
  if (!isValidPageSummary(summary)) {
    throw new BadRequestException({
      error: `summary must be at most ${SUMMARY_MAX_LENGTH} characters`,
    });
  }
  return summary;
}

/** Trimmed image reference; '' is legal and means "no image" (clears on revise). */
function parseImage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'image must be a string' });
  }
  const image = value.trim();
  if (image !== '' && !isValidPageImage(image)) {
    throw new BadRequestException({
      error: 'image must be an https:// URL or an asset:<token> reference',
    });
  }
  return image;
}

/**
 * Trimmed `owner/name` reference; '' is legal and means "no repo" (clears
 * on revise). Anything else that is not a valid reference is a 400 here
 * rather than a surprise upstream URL later.
 */
function parseRepo(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'repo must be a string' });
  }
  const repo = value.trim();
  if (repo !== '' && !isValidPageRepo(repo)) {
    throw new BadRequestException({
      error: 'repo must be an owner/name reference, e.g. octocat/hello-world',
    });
  }
  return repo;
}

/**
 * The gallery as the API accepts it: an ARRAY of `{ref, caption?}` entries
 * (a bare string is the caption-less shorthand), at most
 * GALLERY_MAX_ENTRIES of them, each `ref` held to exactly the rule `image`
 * is held to — so nothing a page can hang in a lightbox is a reference the
 * page could not have used as its card image. Refs and captions are
 * trimmed; a blank caption is dropped rather than stored. An EMPTY array is
 * legal and means "no gallery" (clears it on revise).
 */
function parseGallery(value: unknown): PageGalleryEntry[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException({
      error: 'gallery must be an array of {ref, caption?} entries',
    });
  }
  if (value.length > GALLERY_MAX_ENTRIES) {
    throw new BadRequestException({
      error: `gallery must have at most ${GALLERY_MAX_ENTRIES} entries`,
    });
  }
  return value.map((item) => {
    const raw =
      typeof item === 'string'
        ? { ref: item }
        : ((item ?? {}) as Record<string, unknown>);
    if (typeof raw.ref !== 'string') {
      throw new BadRequestException({
        error: 'gallery entries must have a ref',
      });
    }
    const ref = raw.ref.trim();
    if (!isValidPageImage(ref)) {
      throw new BadRequestException({
        error:
          'gallery refs must be an https:// URL or an asset:<token> reference',
      });
    }
    if (raw.caption !== undefined && typeof raw.caption !== 'string') {
      throw new BadRequestException({
        error: 'gallery captions must be strings',
      });
    }
    const caption = (raw.caption ?? '').trim();
    return { ref, ...(caption !== '' ? { caption } : {}) };
  });
}

/** Validates a POST /api/pages payload; throws 400 on anything malformed. */
export function validateNewPage(payload: unknown): NewPageInput {
  const raw = (payload ?? {}) as Record<string, unknown>;

  const { title } = raw;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new BadRequestException({ error: 'title must be a non-empty string' });
  }
  const body = parseBody(raw.body);
  // On create there is nothing to clear, so an empty value is simply absent.
  const summary = raw.summary !== undefined ? parseSummary(raw.summary) : '';
  const image = raw.image !== undefined ? parseImage(raw.image) : '';
  const repo = raw.repo !== undefined ? parseRepo(raw.repo) : '';
  const gallery = raw.gallery !== undefined ? parseGallery(raw.gallery) : [];

  let draft = false;
  if (raw.draft !== undefined) {
    if (typeof raw.draft !== 'boolean') {
      throw new BadRequestException({ error: 'draft must be a boolean' });
    }
    draft = raw.draft;
  }

  return {
    title: title.trim(),
    body,
    ...(summary !== '' ? { summary } : {}),
    ...(image !== '' ? { image } : {}),
    ...(repo !== '' ? { repo } : {}),
    ...(gallery.length > 0 ? { gallery } : {}),
    draft,
  };
}

/**
 * Validates a PATCH /api/pages/:slug payload into PageRevised changes;
 * throws 400 when malformed or when no recognized field is present.
 */
export function validatePageRevision(payload: unknown): PageRevisionChanges {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const changes: PageRevisionChanges = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
      throw new BadRequestException({
        error: 'title must be a non-empty string',
      });
    }
    changes.title = raw.title.trim();
  }
  if (raw.body !== undefined) {
    changes.body = parseBody(raw.body);
  }
  // Empty string is a meaningful revision here: it clears the field.
  if (raw.summary !== undefined) {
    changes.summary = parseSummary(raw.summary);
  }
  if (raw.image !== undefined) {
    changes.image = parseImage(raw.image);
  }
  if (raw.repo !== undefined) {
    changes.repo = parseRepo(raw.repo);
  }
  // Same rule one level up: [] is a real revision, it clears the gallery.
  if (raw.gallery !== undefined) {
    changes.gallery = parseGallery(raw.gallery);
  }

  if (Object.keys(changes).length === 0) {
    throw new BadRequestException({
      error:
        'at least one of title, body, summary, image, repo, gallery is required',
    });
  }
  return changes;
}
