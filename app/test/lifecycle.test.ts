import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BlogService } from '../src/blog/blog.service';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import { validateNewPost, validateRevision } from '../src/blog/validate';

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeService(): Promise<{
  service: BlogService;
  storePath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-lifecycle-'));
  tempDirs.push(dir);
  const storePath = path.join(dir, 'events.jsonl');
  const service = new BlogService(
    new FileEventStore(storePath),
    new PostsProjection(),
  );
  return { service, storePath };
}

async function eventTypes(storePath: string): Promise<string[]> {
  const types: string[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    types.push(event.type);
  }
  return types;
}

test('draft -> publish -> revise -> unpublish -> republish', async () => {
  const { service, storePath } = await makeService();

  // draft:true appends PostDrafted only.
  const draft = await service.createPost(
    validateNewPost({ title: 'My Story', deck: 'v1', draft: true }),
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.publishedAt, undefined);
  assert.deepEqual(await eventTypes(storePath), ['PostDrafted']);
  assert.equal(service.listPublished().length, 0);
  assert.equal(service.listAll().length, 1);

  // publish
  const published = await service.publishPost('my-story');
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);
  assert.equal(service.listPublished().length, 1);
  const firstPublishedAt = published.publishedAt;

  // revise merges only the given changes and bumps updatedAt.
  const revised = await service.revisePost(
    'my-story',
    validateRevision({ deck: 'v2', body: 'hello' }),
  );
  assert.equal(revised.title, 'My Story');
  assert.equal(revised.deck, 'v2');
  assert.equal(revised.body, 'hello');
  assert.equal(revised.status, 'published');
  assert.ok(revised.updatedAt >= published.updatedAt);

  // unpublish hides the post from public reads but keeps it (and its history).
  const unpublished = await service.unpublishPost('my-story');
  assert.equal(unpublished.status, 'unpublished');
  assert.equal(service.listPublished().length, 0);
  assert.throws(() => service.getPublished('my-story'), NotFoundException);
  assert.equal(service.getAny('my-story').deck, 'v2');

  // republish makes it public again.
  const republished = await service.publishPost('my-story');
  assert.equal(republished.status, 'published');
  assert.ok(republished.publishedAt);
  assert.ok(republished.publishedAt! >= firstPublishedAt!);
  assert.equal(service.listPublished().length, 1);

  assert.deepEqual(await eventTypes(storePath), [
    'PostDrafted',
    'PostPublished',
    'PostRevised',
    'PostUnpublished',
    'PostPublished',
  ]);

  // Full replay into a fresh projection reproduces the same read model.
  const projection = new PostsProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }
  assert.deepEqual(projection.get('my-story'), republished);
});

test('publish and unpublish are idempotent (200, no new event)', async () => {
  const { service, storePath } = await makeService();
  await service.createPost(validateNewPost({ title: 'Once', deck: 'd' }));
  assert.equal((await eventTypes(storePath)).length, 2);

  const again = await service.publishPost('once');
  assert.equal(again.status, 'published');
  assert.equal((await eventTypes(storePath)).length, 2, 'no PostPublished appended');

  await service.unpublishPost('once');
  assert.equal((await eventTypes(storePath)).length, 3);
  const still = await service.unpublishPost('once');
  assert.equal(still.status, 'unpublished');
  assert.equal((await eventTypes(storePath)).length, 3, 'no PostUnpublished appended');
});

test('listAll orders by updatedAt desc and includes every status', async () => {
  const { service } = await makeService();
  await service.createPost(validateNewPost({ title: 'A', deck: 'd' }));
  await service.createPost(validateNewPost({ title: 'B', deck: 'd', draft: true }));
  await service.revisePost('a', validateRevision({ deck: 'later' }));

  const all = service.listAll();
  assert.deepEqual(
    all.map((post) => post.slug),
    ['a', 'b'],
    'a revised last, so it sorts first',
  );
  assert.deepEqual(
    all.map((post) => post.status),
    ['published', 'draft'],
  );
});

test('getEvents returns only that slug, seq ascending; 404 unknown', async () => {
  const { service } = await makeService();
  await service.createPost(validateNewPost({ title: 'One', deck: 'd' }));
  await service.createPost(validateNewPost({ title: 'Two', deck: 'd' }));
  await service.revisePost('one', validateRevision({ body: 'x' }));

  const events = await service.getEvents('one');
  assert.deepEqual(
    events.map((event) => event.type),
    ['PostDrafted', 'PostPublished', 'PostRevised'],
  );
  const seqs = events.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(events.every((event) => (event.data as { slug: string }).slug === 'one'));

  await assert.rejects(() => service.getEvents('nope'), NotFoundException);
});

test('revise/publish/unpublish reject unknown slugs with 404', async () => {
  const { service } = await makeService();
  await assert.rejects(
    () => service.revisePost('ghost', { title: 'x' }),
    NotFoundException,
  );
  await assert.rejects(() => service.publishPost('ghost'), NotFoundException);
  await assert.rejects(() => service.unpublishPost('ghost'), NotFoundException);
});

test('validateRevision rejects empty or malformed changes', () => {
  assert.throws(() => validateRevision({}), BadRequestException);
  assert.throws(() => validateRevision(undefined), BadRequestException);
  assert.throws(() => validateRevision({ unknown: 'field' }), BadRequestException);
  assert.throws(() => validateRevision({ title: '  ' }), BadRequestException);
  assert.throws(() => validateRevision({ deck: 7 }), BadRequestException);
  assert.throws(() => validateRevision({ tags: ['a', 1] }), BadRequestException);
  assert.throws(() => validateRevision({ body: 5 }), BadRequestException);

  assert.deepEqual(validateRevision({ title: ' T ' }), { title: 'T' });
  assert.deepEqual(validateRevision({ tags: [], body: '' }), { tags: [], body: '' });
});

test('validateNewPost handles the draft flag', () => {
  assert.equal(validateNewPost({ title: 't', deck: 'd' }).draft, false);
  assert.equal(validateNewPost({ title: 't', deck: 'd', draft: true }).draft, true);
  assert.throws(
    () => validateNewPost({ title: 't', deck: 'd', draft: 'yes' }),
    BadRequestException,
  );
});
