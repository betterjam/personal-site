import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BlogService } from '../src/blog/blog.service';
import { POST_DRAFTED, POST_PUBLISHED } from '../src/blog/events';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import { validateNewPost } from '../src/blog/validate';
import { PAGE_CREATED, PAGE_PUBLISHED } from '../src/pages/events';
import { PagesProjection } from '../src/pages/pages.projection';
import { PagesService } from '../src/pages/pages.service';
import { validateNewPage, validatePageRevision } from '../src/pages/validate';

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Pages and posts services over ONE shared store and shared posts
 * projection, the same wiring the app modules produce: one log, one slug
 * namespace.
 */
async function makeServices(): Promise<{
  pages: PagesService;
  blog: BlogService;
  storePath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-lifecycle-'));
  tempDirs.push(dir);
  const storePath = path.join(dir, 'events.jsonl');
  const store = new FileEventStore(storePath);
  const posts = new PostsProjection();
  return {
    pages: new PagesService(store, new PagesProjection(), posts),
    blog: new BlogService(store, posts),
    storePath,
  };
}

async function eventTypes(storePath: string): Promise<string[]> {
  const types: string[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    types.push(event.type);
  }
  return types;
}

test('page: create draft -> publish -> revise -> unpublish -> republish', async () => {
  const { pages, storePath } = await makeServices();

  // draft:true appends PageCreated only.
  const draft = await pages.createPage(
    validateNewPage({ title: 'About Me', body: 'v1', draft: true }),
  );
  assert.equal(draft.slug, 'about-me');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.publishedAt, undefined);
  assert.deepEqual(await eventTypes(storePath), ['PageCreated']);
  assert.equal(pages.listPublished().length, 0);
  assert.equal(pages.listAll().length, 1);

  // publish
  const published = await pages.publishPage('about-me');
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);
  assert.equal(pages.listPublished().length, 1);
  const firstPublishedAt = published.publishedAt;

  // revise merges only the given changes and bumps updatedAt.
  const revised = await pages.revisePage(
    'about-me',
    validatePageRevision({ body: 'v2' }),
  );
  assert.equal(revised.title, 'About Me');
  assert.equal(revised.body, 'v2');
  assert.equal(revised.status, 'published');
  assert.ok(revised.updatedAt >= published.updatedAt);

  // unpublish hides the page from public reads but keeps it (and its history).
  const unpublished = await pages.unpublishPage('about-me');
  assert.equal(unpublished.status, 'unpublished');
  assert.equal(pages.listPublished().length, 0);
  assert.throws(() => pages.getPublished('about-me'), NotFoundException);
  assert.equal(pages.getAny('about-me').body, 'v2');

  // republish makes it public again.
  const republished = await pages.publishPage('about-me');
  assert.equal(republished.status, 'published');
  assert.ok(republished.publishedAt! >= firstPublishedAt!);
  assert.equal(pages.listPublished().length, 1);

  assert.deepEqual(await eventTypes(storePath), [
    'PageCreated',
    'PagePublished',
    'PageRevised',
    'PageUnpublished',
    'PagePublished',
  ]);

  // Boot semantics: a fresh service over the same log replays to the same
  // read model (restart = reset + full replay; 'about-me' has page events,
  // so the per-slug seeder leaves it alone — PAGES_DIR points away from
  // the repo's real content/pages so no unrelated files seed either).
  const rebooted = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  const previousPagesDir = process.env.PAGES_DIR;
  process.env.PAGES_DIR = path.join(path.dirname(storePath), 'no-such-pages');
  try {
    await rebooted.onModuleInit();
  } finally {
    if (previousPagesDir === undefined) delete process.env.PAGES_DIR;
    else process.env.PAGES_DIR = previousPagesDir;
  }
  assert.deepEqual(rebooted.getAny('about-me'), republished);
  assert.deepEqual(await eventTypes(storePath), [
    'PageCreated',
    'PagePublished',
    'PageRevised',
    'PageUnpublished',
    'PagePublished',
  ]);
});

test('page publish and unpublish are idempotent (200, no new event)', async () => {
  const { pages, storePath } = await makeServices();
  await pages.createPage(validateNewPage({ title: 'Now', body: 'b' }));
  assert.deepEqual(await eventTypes(storePath), ['PageCreated', 'PagePublished']);

  const again = await pages.publishPage('now');
  assert.equal(again.status, 'published');
  assert.equal((await eventTypes(storePath)).length, 2, 'no PagePublished appended');

  await pages.unpublishPage('now');
  assert.equal((await eventTypes(storePath)).length, 3);
  const still = await pages.unpublishPage('now');
  assert.equal(still.status, 'unpublished');
  assert.equal((await eventTypes(storePath)).length, 3, 'no PageUnpublished appended');
});

test('GET /api/pages shape: summaries of published pages, title asc', async () => {
  const { pages } = await makeServices();
  await pages.createPage(validateNewPage({ title: 'Zebra', body: 'z' }));
  await pages.createPage(validateNewPage({ title: 'About', body: 'a' }));
  await pages.createPage(validateNewPage({ title: 'Hidden', body: 'h', draft: true }));

  const list = pages.listPublished();
  assert.deepEqual(
    list.map((page) => page.title),
    ['About', 'Zebra'],
    'published only, title ascending',
  );
  for (const item of list) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['publishedAt', 'slug', 'title'],
      'summary carries no body/status/updatedAt',
    );
    assert.ok(item.publishedAt);
  }

  // Admin list: every status. (Ordering is asserted deterministically in
  // the projection test below — back-to-back creates can share a
  // millisecond, so slug order here is not stable.)
  assert.deepEqual(
    pages.listAll().map((page) => page.slug).sort(),
    ['about', 'hidden', 'zebra'],
  );
});

test('pages listAll orders by updatedAt desc across statuses', async () => {
  const { storePath } = await makeServices();
  const store = new FileEventStore(storePath);

  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'oldest', title: 'Oldest', body: 'o' },
  });
  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-02T00:00:00.000Z',
    data: { slug: 'draft-page', title: 'Draft Page', body: 'd' },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-03T00:00:00.000Z',
    data: { slug: 'oldest', publishedAt: '2026-08-03T00:00:00.000Z' },
  });

  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }

  // 'oldest' was touched last (its publish), so it sorts first.
  assert.deepEqual(
    projection.listAll().map((page) => page.slug),
    ['oldest', 'draft-page'],
  );
  assert.deepEqual(
    projection.listAll().map((page) => page.status),
    ['published', 'draft'],
  );
});

test('slug namespace is shared: page colliding with a post slug is 409', async () => {
  const { pages, blog } = await makeServices();
  await blog.createPost(validateNewPost({ title: 'About', deck: 'd' }));

  await assert.rejects(
    () => pages.createPage(validateNewPage({ title: 'About', body: 'b' })),
    ConflictException,
  );
  // Page/page duplicates conflict too.
  await pages.createPage(validateNewPage({ title: 'Contact', body: 'c' }));
  await assert.rejects(
    () => pages.createPage(validateNewPage({ title: 'Contact!', body: 'c2' })),
    ConflictException,
    'kebab-cased titles collide on the same slug',
  );
});

test('posts and pages projections ignore each other\'s events', async () => {
  const { storePath } = await makeServices();
  const store = new FileEventStore(storePath);

  await store.append({
    type: POST_DRAFTED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'a-post', title: 'A Post', deck: 'one', tags: [] },
  });
  await store.append({
    type: POST_PUBLISHED,
    at: '2026-08-02T00:00:00.000Z',
    data: { slug: 'a-post', publishedAt: '2026-08-02T00:00:00.000Z' },
  });
  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-03T00:00:00.000Z',
    data: { slug: 'a-page', title: 'A Page', body: 'hello' },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-04T00:00:00.000Z',
    data: { slug: 'a-page', publishedAt: '2026-08-04T00:00:00.000Z' },
  });

  const posts = new PostsProjection();
  const pages = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    posts.apply(event);
    pages.apply(event);
  }

  assert.deepEqual(
    posts.listPublished().map((post) => post.slug),
    ['a-post'],
    'posts projection sees only post events',
  );
  assert.equal(posts.has('a-page'), false);

  assert.deepEqual(
    pages.listPublished().map((page) => page.slug),
    ['a-page'],
    'pages projection sees only page events',
  );
  assert.equal(pages.has('a-post'), false);
  assert.equal(pages.get('a-page')?.publishedAt, '2026-08-04T00:00:00.000Z');
});

test('page getEvents returns only that slug, seq ascending; 404 unknown', async () => {
  const { pages } = await makeServices();
  await pages.createPage(validateNewPage({ title: 'One', body: 'b' }));
  await pages.createPage(validateNewPage({ title: 'Two', body: 'b' }));
  await pages.revisePage('one', validatePageRevision({ body: 'x' }));

  const events = await pages.getEvents('one');
  assert.deepEqual(
    events.map((event) => event.type),
    ['PageCreated', 'PagePublished', 'PageRevised'],
  );
  const seqs = events.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(events.every((event) => (event.data as { slug: string }).slug === 'one'));

  await assert.rejects(() => pages.getEvents('nope'), NotFoundException);
});

test('page revise/publish/unpublish reject unknown slugs with 404', async () => {
  const { pages } = await makeServices();
  await assert.rejects(
    () => pages.revisePage('ghost', { title: 'x' }),
    NotFoundException,
  );
  await assert.rejects(() => pages.publishPage('ghost'), NotFoundException);
  await assert.rejects(() => pages.unpublishPage('ghost'), NotFoundException);
});

test('pages boot without a seed directory: an empty log stays empty', async () => {
  const { pages, storePath } = await makeServices();
  // Point PAGES_DIR away from the repo's real content/pages; a missing
  // directory makes seeding a quiet no-op (see pages-seed.test.ts for the
  // seeding path itself).
  const previous = process.env.PAGES_DIR;
  process.env.PAGES_DIR = path.join(path.dirname(storePath), 'no-such-pages');
  try {
    await pages.onModuleInit();
  } finally {
    if (previous === undefined) delete process.env.PAGES_DIR;
    else process.env.PAGES_DIR = previous;
  }
  assert.deepEqual(await eventTypes(storePath), []);
  assert.deepEqual(pages.listAll(), []);
});

test('validateNewPage rejects malformed payloads', () => {
  assert.throws(() => validateNewPage({}), BadRequestException);
  assert.throws(() => validateNewPage({ title: '  ', body: 'b' }), BadRequestException);
  assert.throws(() => validateNewPage({ title: 'T' }), BadRequestException);
  assert.throws(() => validateNewPage({ title: 'T', body: 7 }), BadRequestException);
  assert.throws(
    () => validateNewPage({ title: 'T', body: 'b', draft: 'yes' }),
    BadRequestException,
  );

  assert.deepEqual(validateNewPage({ title: ' T ', body: '' }), {
    title: 'T',
    body: '',
    draft: false,
  });
  assert.equal(validateNewPage({ title: 'T', body: 'b', draft: true }).draft, true);
});

test('validatePageRevision rejects empty or malformed changes', () => {
  assert.throws(() => validatePageRevision({}), BadRequestException);
  assert.throws(() => validatePageRevision(undefined), BadRequestException);
  assert.throws(() => validatePageRevision({ unknown: 'field' }), BadRequestException);
  assert.throws(() => validatePageRevision({ title: '  ' }), BadRequestException);
  assert.throws(() => validatePageRevision({ body: 5 }), BadRequestException);

  assert.deepEqual(validatePageRevision({ title: ' T ' }), { title: 'T' });
  assert.deepEqual(validatePageRevision({ body: '' }), { body: '' });
});
