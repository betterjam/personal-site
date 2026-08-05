import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { EventStore } from '../src/blog/event-store';
import { POST_DRAFTED, POST_PUBLISHED } from '../src/blog/events';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import { DeploysProjection } from '../src/meta/deploys.projection';
import { DEPLOY_RECORDED } from '../src/meta/events';
import { MetaService } from '../src/meta/meta.service';

const tempDirs: string[] = [];

async function tempStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-events-'));
  tempDirs.push(dir);
  return path.join(dir, 'events.jsonl');
}

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Runs fn with GIT_SHA/BUILD_TIME set (undefined = unset), then restores. */
async function withEnv(
  env: { GIT_SHA?: string; BUILD_TIME?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const saved = {
    GIT_SHA: process.env.GIT_SHA,
    BUILD_TIME: process.env.BUILD_TIME,
  };
  const set = (key: 'GIT_SHA' | 'BUILD_TIME', value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set('GIT_SHA', env.GIT_SHA);
  set('BUILD_TIME', env.BUILD_TIME);
  try {
    await fn();
  } finally {
    set('GIT_SHA', saved.GIT_SHA);
    set('BUILD_TIME', saved.BUILD_TIME);
  }
}

/** Fresh service over the store, initialized: restart semantics. */
async function bootMeta(store: EventStore): Promise<MetaService> {
  const service = new MetaService(store, new DeploysProjection());
  await service.onModuleInit();
  return service;
}

async function eventTypes(storePath: string): Promise<string[]> {
  const types: string[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    types.push(event.type);
  }
  return types;
}

test('same sha across restarts appends one DeployRecorded event', async () => {
  const storePath = await tempStorePath();
  await withEnv(
    { GIT_SHA: 'aaa1111', BUILD_TIME: '2026-08-01T00:00:00.000Z' },
    async () => {
      await bootMeta(new FileEventStore(storePath));
      await bootMeta(new FileEventStore(storePath)); // redeploy of same build
      assert.deepEqual(await eventTypes(storePath), [DEPLOY_RECORDED]);
    },
  );
});

test('a new sha appends a new DeployRecorded event', async () => {
  const storePath = await tempStorePath();
  await withEnv(
    { GIT_SHA: 'aaa1111', BUILD_TIME: '2026-08-01T00:00:00.000Z' },
    async () => {
      await bootMeta(new FileEventStore(storePath));
    },
  );
  await withEnv(
    { GIT_SHA: 'bbb2222', BUILD_TIME: '2026-08-02T00:00:00.000Z' },
    async () => {
      const service = await bootMeta(new FileEventStore(storePath));
      assert.deepEqual(await eventTypes(storePath), [
        DEPLOY_RECORDED,
        DEPLOY_RECORDED,
      ]);
      assert.deepEqual(service.getMeta().deploys, [
        { sha: 'bbb2222', at: '2026-08-02T00:00:00.000Z' },
        { sha: 'aaa1111', at: '2026-08-01T00:00:00.000Z' },
      ]);
    },
  );
});

test('unset GIT_SHA records nothing and meta falls back to dev defaults', async () => {
  const storePath = await tempStorePath();
  await withEnv({}, async () => {
    const service = await bootMeta(new FileEventStore(storePath));
    assert.deepEqual(await eventTypes(storePath), []);

    const meta = service.getMeta();
    assert.deepEqual(Object.keys(meta).sort(), ['builtAt', 'commit', 'deploys']);
    assert.equal(meta.commit, 'dev');
    assert.ok(!Number.isNaN(Date.parse(meta.builtAt)), 'builtAt is ISO');
    assert.deepEqual(meta.deploys, []);
  });
});

test('meta reports commit/builtAt from env and at most 5 deploys, newest first', async () => {
  const storePath = await tempStorePath();
  const store = new FileEventStore(storePath);
  for (let i = 1; i <= 6; i += 1) {
    await store.append({
      type: DEPLOY_RECORDED,
      at: `2026-08-0${i}T00:00:00.000Z`,
      data: { sha: `sha${i}`, at: `2026-08-0${i}T00:00:00.000Z` },
    });
  }

  await withEnv(
    { GIT_SHA: 'sha6', BUILD_TIME: '2026-08-06T00:00:00.000Z' },
    async () => {
      const service = await bootMeta(new FileEventStore(storePath));
      const meta = service.getMeta();

      assert.equal(meta.commit, 'sha6');
      assert.equal(meta.builtAt, '2026-08-06T00:00:00.000Z');
      assert.deepEqual(
        meta.deploys.map((deploy) => deploy.sha),
        ['sha6', 'sha5', 'sha4', 'sha3', 'sha2'],
        'last 5 deploys, newest first',
      );
      // sha6 was already the latest deploy: replay-only, no new event.
      assert.equal((await eventTypes(storePath)).length, 6);
    },
  );
});

test('posts and deploys projections ignore each other\'s events', async () => {
  const storePath = await tempStorePath();
  const store = new FileEventStore(storePath);

  await store.append({
    type: DEPLOY_RECORDED,
    at: '2026-08-01T00:00:00.000Z',
    data: { sha: 'aaa1111', at: '2026-08-01T00:00:00.000Z' },
  });
  await store.append({
    type: POST_DRAFTED,
    at: '2026-08-02T00:00:00.000Z',
    data: { slug: 'first', title: 'First', deck: 'one', tags: [] },
  });
  await store.append({
    type: POST_PUBLISHED,
    at: '2026-08-03T00:00:00.000Z',
    data: { slug: 'first', publishedAt: '2026-08-03T00:00:00.000Z' },
  });
  await store.append({
    type: DEPLOY_RECORDED,
    at: '2026-08-04T00:00:00.000Z',
    data: { sha: 'bbb2222', at: '2026-08-04T00:00:00.000Z' },
  });

  const posts = new PostsProjection();
  const deploys = new DeploysProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    posts.apply(event);
    deploys.apply(event);
  }

  const published = posts.listPublished();
  assert.deepEqual(
    published.map((post) => post.slug),
    ['first'],
    'posts projection sees only post events',
  );
  assert.equal(published[0].publishedAt, '2026-08-03T00:00:00.000Z');

  assert.deepEqual(deploys.lastN(5), [
    { sha: 'bbb2222', at: '2026-08-04T00:00:00.000Z' },
    { sha: 'aaa1111', at: '2026-08-01T00:00:00.000Z' },
  ]);
  assert.equal(deploys.latest()?.sha, 'bbb2222');
});
