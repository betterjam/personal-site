import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { BlogService } from '../src/blog/blog.service';
import { StoredEvent } from '../src/blog/event-store';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import { PAGE_CREATED } from '../src/pages/events';
import { PagesProjection } from '../src/pages/pages.projection';
import { PagesService } from '../src/pages/pages.service';

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readEvents(storePath: string): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  for await (const event of new FileEventStore(storePath).readAll()) {
    events.push(event);
  }
  return events;
}

/** Runs fn with the given env vars set (undefined = unset), then restores. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('pages seed: empty store boots PageCreated+PagePublished per file, filename order', async () => {
  const pagesDir = await tempDir('pages-seed-content-');
  // Deliberately out of creation order vs. filename order; sorted order is
  // about.md, guitar-shelf.md, zz-last.md.
  await fs.writeFile(
    path.join(pagesDir, 'zz-last.md'),
    '# Last Page\nNo blank line after the heading here.\n',
  );
  await fs.writeFile(
    path.join(pagesDir, 'about.md'),
    '# About Me\n\nFirst paragraph.\n\nSecond paragraph.\n',
  );
  // No '# ' heading: title falls back to the humanized filename.
  await fs.writeFile(
    path.join(pagesDir, 'guitar-shelf.md'),
    'Every color was stolen from a guitar.\n',
  );
  // Non-Markdown files are ignored.
  await fs.writeFile(path.join(pagesDir, 'notes.txt'), 'not a page');

  const storeDir = await tempDir('pages-seed-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const service = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );

  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  const events = await readEvents(storePath);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'PageCreated',
      'PagePublished',
      'PageCreated',
      'PagePublished',
      'PageCreated',
      'PagePublished',
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === PAGE_CREATED)
      .map((event) => (event.data as { slug: string }).slug),
    ['about', 'guitar-shelf', 'zz-last'],
    'seeded in filename order',
  );

  // Heading line becomes the title; it and one following blank line leave
  // the body, which is trimmed.
  const about = service.getAny('about');
  assert.equal(about.title, 'About Me');
  assert.equal(about.body, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(about.status, 'published');
  assert.ok(!Number.isNaN(Date.parse(about.publishedAt!)), 'publishedAt is ISO');

  // Heading with no blank line after it: only the heading is stripped.
  const last = service.getAny('zz-last');
  assert.equal(last.title, 'Last Page');
  assert.equal(last.body, 'No blank line after the heading here.');

  // No heading: humanized filename, whole file as body.
  const shelf = service.getAny('guitar-shelf');
  assert.equal(shelf.title, 'Guitar Shelf');
  assert.equal(shelf.body, 'Every color was stolen from a guitar.');

  assert.equal(service.listPublished().length, 3);

  // Reboot over the seeded log: every slug has events, so replay only.
  const rebooted = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await rebooted.onModuleInit();
  });
  assert.equal((await readEvents(storePath)).length, 6, 'no events appended');
  assert.deepEqual(rebooted.getAny('about'), about);

  // A NEW file dropped in later seeds just that file on the next boot;
  // the three already-seeded slugs are untouched.
  await fs.writeFile(
    path.join(pagesDir, 'later.md'),
    '# Added Later\n\nNew file, new page.\n',
  );
  const thirdBoot = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await thirdBoot.onModuleInit();
  });
  const afterThird = await readEvents(storePath);
  assert.equal(afterThird.length, 8, 'exactly one Created+Published pair added');
  assert.deepEqual(
    afterThird.slice(6).map((event) => [
      event.type,
      (event.data as { slug: string }).slug,
    ]),
    [
      ['PageCreated', 'later'],
      ['PagePublished', 'later'],
    ],
  );
  assert.equal(thirdBoot.getAny('later').title, 'Added Later');
  assert.deepEqual(thirdBoot.getAny('about'), about, 'existing page untouched');
});

test('pages seed is per slug: only files whose slug has no events seed', async () => {
  const pagesDir = await tempDir('pages-seed-partial-content-');
  await fs.writeFile(path.join(pagesDir, 'about.md'), '# About\n\nFrom file.\n');
  await fs.writeFile(path.join(pagesDir, 'now.md'), '# Now\n\nOn the bench.\n');
  await fs.writeFile(path.join(pagesDir, 'uses.md'), '# Uses\n\nTools.\n');

  // 'about' already has history — a lone draft event is enough to make the
  // seeder keep its hands off that slug forever.
  const storeDir = await tempDir('pages-seed-partial-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  await new FileEventStore(storePath).append({
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'about', title: 'About (authored live)', body: 'kept' },
  });

  const service = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  const events = await readEvents(storePath);
  assert.deepEqual(
    events.map((event) => [event.type, (event.data as { slug: string }).slug]),
    [
      ['PageCreated', 'about'],
      ['PageCreated', 'now'],
      ['PagePublished', 'now'],
      ['PageCreated', 'uses'],
      ['PagePublished', 'uses'],
    ],
    'missing slugs seed in filename order; about is not re-seeded',
  );
  const about = service.getAny('about');
  assert.equal(about.title, 'About (authored live)');
  assert.equal(about.body, 'kept');
  assert.equal(about.status, 'draft', 'seeder did not publish the existing draft');
  assert.deepEqual(
    service.listPublished().map((page) => page.slug),
    ['now', 'uses'],
  );
});

test('a revised-then-unpublished slug is never re-seeded from its file', async () => {
  const pagesDir = await tempDir('pages-seed-detached-content-');
  await fs.writeFile(
    path.join(pagesDir, 'colophon.md'),
    '# Colophon\n\nFile version.\n',
  );

  const storeDir = await tempDir('pages-seed-detached-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const first = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await first.onModuleInit();
  });
  assert.equal((await readEvents(storePath)).length, 2, 'seeded once');

  // Maintainer edits detach the page from its file: revise, then unpublish.
  await first.revisePage('colophon', { body: 'Edited in the maintainer.' });
  await first.unpublishPage('colophon');

  // Reboot with the file still present: the slug has events, so nothing
  // seeds — the page stays unpublished with the revised body, and the file
  // never resurrects or overwrites it.
  const rebooted = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await rebooted.onModuleInit();
  });
  assert.deepEqual(
    (await readEvents(storePath)).map((event) => event.type),
    ['PageCreated', 'PagePublished', 'PageRevised', 'PageUnpublished'],
    'replay-only reboot; no re-seed of the detached slug',
  );
  const page = rebooted.getAny('colophon');
  assert.equal(page.status, 'unpublished');
  assert.equal(page.body, 'Edited in the maintainer.');
  assert.deepEqual(rebooted.listPublished(), []);
});

test('pages seed: missing or empty PAGES_DIR is a quiet no-op', async () => {
  const storeDir = await tempDir('pages-seed-noop-store-');
  const storePath = path.join(storeDir, 'events.jsonl');

  const missing = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv(
    { PAGES_DIR: path.join(storeDir, 'does-not-exist') },
    async () => {
      await missing.onModuleInit();
    },
  );
  assert.deepEqual(await readEvents(storePath), []);
  assert.deepEqual(missing.listAll(), []);

  const emptyDir = await tempDir('pages-seed-empty-content-');
  const empty = new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
  await withEnv({ PAGES_DIR: emptyDir }, async () => {
    await empty.onModuleInit();
  });
  assert.deepEqual(await readEvents(storePath), []);
});

test('posts seeding is unaffected: blog then pages boot seeds both streams', async () => {
  // Production wiring and order: BlogModule inits before PagesModule, one
  // shared store. The blog seeds an empty log from content.json; the pages
  // boot then sees a non-empty log where no PAGE slug has events, so every
  // file still seeds — post events never suppress the per-slug page seed.
  const contentDir = await tempDir('pages-seed-blog-content-');
  await fs.writeFile(
    path.join(contentDir, 'content.json'),
    JSON.stringify({
      sections: [
        {
          id: 'blog',
          items: [
            { title: 'Hello World', deck: 'first', tags: ['t'], date: '2026-01-05' },
          ],
        },
      ],
    }),
  );
  const pagesDir = await tempDir('pages-seed-both-pages-');
  await fs.writeFile(path.join(pagesDir, 'now.md'), '# Now\n\nOn the bench.\n');

  const storeDir = await tempDir('pages-seed-both-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const store = new FileEventStore(storePath);
  const posts = new PostsProjection();
  const blog = new BlogService(store, posts);
  const pages = new PagesService(store, new PagesProjection(), posts);

  await withEnv({ CONTENT_DIR: contentDir, PAGES_DIR: pagesDir }, async () => {
    await blog.onModuleInit();
    await pages.onModuleInit();
  });

  assert.deepEqual(
    (await readEvents(storePath)).map((event) => event.type),
    ['PostDrafted', 'PostPublished', 'PageCreated', 'PagePublished'],
  );
  assert.deepEqual(
    blog.listPublished().map((post) => post.slug),
    ['hello-world'],
    'post seeding untouched by page seeding',
  );
  assert.deepEqual(
    pages.listPublished().map((page) => page.slug),
    ['now'],
  );
  assert.equal(pages.getAny('now').body, 'On the bench.');
});
