import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { evaluateAdminAccess } from '../src/blog/admin.guard';
import { BlogService } from '../src/blog/blog.service';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import { validateNewPost } from '../src/blog/validate';

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

test('admin access is disabled (503) when ADMIN_TOKEN is unset', () => {
  assert.equal(evaluateAdminAccess(undefined, 'anything'), 'disabled');
  assert.equal(evaluateAdminAccess('', 'anything'), 'disabled');
});

test('admin access is unauthorized (401) on missing or wrong token', () => {
  assert.equal(evaluateAdminAccess('secret', undefined), 'unauthorized');
  assert.equal(evaluateAdminAccess('secret', ''), 'unauthorized');
  assert.equal(evaluateAdminAccess('secret', 'nope'), 'unauthorized');
  assert.equal(evaluateAdminAccess('secret', 'secret-but-longer'), 'unauthorized');
});

test('admin access is granted on exact token match', () => {
  assert.equal(evaluateAdminAccess('secret', 'secret'), 'ok');
});

test('validateNewPost rejects missing/blank title or deck', () => {
  assert.throws(() => validateNewPost({}), BadRequestException);
  assert.throws(() => validateNewPost({ title: '  ', deck: 'x' }), BadRequestException);
  assert.throws(() => validateNewPost({ title: 'x', deck: 42 }), BadRequestException);
  assert.throws(
    () => validateNewPost({ title: 'x', deck: 'y', tags: ['a', 1] }),
    BadRequestException,
  );
});

test('createPost appends drafted+published and returns the published post', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-create-'));
  tempDirs.push(dir);
  const storePath = path.join(dir, 'events.jsonl');
  const store = new FileEventStore(storePath);
  const projection = new PostsProjection();
  const service = new BlogService(store, projection);

  const input = validateNewPost({
    title: 'Hello, Event Sourcing!',
    deck: 'A first post',
    tags: ['es'],
  });
  const post = await service.createPost(input);

  assert.equal(post.slug, 'hello-event-sourcing');
  assert.equal(post.status, 'published');
  assert.ok(post.publishedAt);
  assert.equal(service.listPublished().length, 1);

  // The write went through the log: two events on disk, replayable.
  const types: string[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    types.push(event.type);
  }
  assert.deepEqual(types, ['PostDrafted', 'PostPublished']);

  // Same slug again conflicts.
  await assert.rejects(() => service.createPost(input), ConflictException);
});
