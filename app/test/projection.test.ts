import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { FileEventStore } from '../src/blog/file-event-store';
import { POST_DRAFTED, POST_PUBLISHED } from '../src/blog/events';
import { PostsProjection } from '../src/blog/posts.projection';

const tempDirs: string[] = [];

async function tempStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-events-'));
  tempDirs.push(dir);
  return path.join(dir, 'events.jsonl');
}

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

test('projection rebuilds the read model from a full replay', async () => {
  const storePath = await tempStorePath();
  const writer = new FileEventStore(storePath);

  await writer.append({
    type: POST_DRAFTED,
    at: '2026-01-01T09:00:00.000Z',
    data: { slug: 'first', title: 'First', deck: 'one', tags: ['a'] },
  });
  await writer.append({
    type: POST_PUBLISHED,
    at: '2026-01-02T09:00:00.000Z',
    data: { slug: 'first', publishedAt: '2026-01-02T09:00:00.000Z' },
  });
  await writer.append({
    type: POST_DRAFTED,
    at: '2026-02-01T09:00:00.000Z',
    data: { slug: 'second', title: 'Second', deck: 'two', tags: [], body: 'hi' },
  });
  await writer.append({
    type: POST_PUBLISHED,
    at: '2026-02-02T09:00:00.000Z',
    data: { slug: 'second', publishedAt: '2026-02-02T09:00:00.000Z' },
  });
  await writer.append({
    type: POST_DRAFTED,
    at: '2026-03-01T09:00:00.000Z',
    data: { slug: 'never-published', title: 'Draft', deck: 'wip', tags: [] },
  });

  // Fresh store instance + fresh projection = restart semantics.
  const reader = new FileEventStore(storePath);
  const projection = new PostsProjection();
  let replayed = 0;
  for await (const event of reader.readAll()) {
    projection.apply(event);
    replayed += 1;
  }

  assert.equal(replayed, 5);

  const published = projection.listPublished();
  assert.deepEqual(
    published.map((post) => post.slug),
    ['second', 'first'],
    'published posts sorted newest first',
  );
  assert.equal(published[0].body, 'hi');
  assert.equal(published[1].title, 'First');
  assert.equal(published[1].publishedAt, '2026-01-02T09:00:00.000Z');

  assert.equal(projection.getPublished('never-published'), undefined);
  assert.equal(projection.has('never-published'), true);
});

test('store assigns increasing seq numbers across restarts', async () => {
  const storePath = await tempStorePath();

  const first = new FileEventStore(storePath);
  const e1 = await first.append({ type: 'A', data: {} });
  const e2 = await first.append({ type: 'B', data: {} });

  const second = new FileEventStore(storePath);
  const e3 = await second.append({ type: 'C', data: {} });

  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);

  const seen: number[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    seen.push(event.seq);
  }
  assert.deepEqual(seen, [1, 2, 3]);
});
