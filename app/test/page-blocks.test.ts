import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { StoredEvent } from '../src/blog/event-store';
import { FileEventStore } from '../src/blog/file-event-store';
import { PostsProjection } from '../src/blog/posts.projection';
import {
  PAGE_CREATED,
  PAGE_PUBLISHED,
  PAGE_REVISED,
  PAGE_UNPUBLISHED,
} from '../src/pages/events';
import { parseFrontMatter } from '../src/pages/front-matter';
import { PagesProjection } from '../src/pages/pages.projection';
import { PagesService } from '../src/pages/pages.service';
import {
  SUMMARY_MAX_LENGTH,
  validateNewPage,
  validatePageRevision,
} from '../src/pages/validate';

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

function makeService(storePath: string): PagesService {
  return new PagesService(
    new FileEventStore(storePath),
    new PagesProjection(),
    new PostsProjection(),
  );
}

// --- front matter parsing -------------------------------------------------

test('front matter: both keys parse out and leave the body clean', () => {
  const { attributes, body } = parseFrontMatter(
    [
      '---',
      'summary: One sentence a card can wear.',
      'image: asset:maintainer',
      '---',
      '# This Site',
      '',
      'First paragraph.',
      '',
    ].join('\n'),
  );

  assert.deepEqual(attributes, {
    summary: 'One sentence a card can wear.',
    image: 'asset:maintainer',
  });
  // The heading is the first line again, so the existing '# Title' rule
  // still fires on the stripped body.
  assert.equal(body, '# This Site\n\nFirst paragraph.\n');
});

test('front matter: either key alone, quotes, and colons inside values', () => {
  assert.deepEqual(
    parseFrontMatter('---\nsummary: Only a summary.\n---\nBody.\n').attributes,
    { summary: 'Only a summary.' },
  );
  assert.deepEqual(
    parseFrontMatter('---\nimage: https://cdn.example.com/a.png?w=1\n---\nB\n')
      .attributes,
    { image: 'https://cdn.example.com/a.png?w=1' },
  );
  // Quoted values unwrap; only the first colon splits key from value.
  assert.deepEqual(
    parseFrontMatter(
      '---\nsummary: "Shipped: on time."\nimage: \'asset:maintainer\'\n---\nB',
    ).attributes,
    { summary: 'Shipped: on time.', image: 'asset:maintainer' },
  );
  // Empty value is the same as an absent key.
  assert.deepEqual(parseFrontMatter('---\nsummary:\n---\nB').attributes, {});
});

test('front matter: unknown keys are ignored, never an error', () => {
  const { attributes, body } = parseFrontMatter(
    [
      '---',
      'summary: Kept.',
      'draft: true',
      'tags: [a, b]',
      'a line with no colon',
      'IMAGE: asset:maintainer',
      '---',
      'Body.',
    ].join('\n'),
  );
  // Keys are matched case-insensitively; everything unrecognized falls away.
  assert.deepEqual(attributes, { summary: 'Kept.', image: 'asset:maintainer' });
  assert.equal(body, 'Body.');
});

test('front matter: files without a block pass through untouched', () => {
  const plain = '# About Me\n\nFirst paragraph.\n\n---\n\nAfter a rule.\n';
  assert.deepEqual(parseFrontMatter(plain), { attributes: {}, body: plain });

  // Opened but never closed: not front matter, so the file is left alone.
  const unterminated = '---\nsummary: dangling\n\n# Title\n';
  assert.deepEqual(parseFrontMatter(unterminated), {
    attributes: {},
    body: unterminated,
  });

  // CRLF authored file, and blank lines after the fence are dropped so the
  // heading rule still applies.
  const crlf = '---\r\nsummary: S\r\n---\r\n\r\n# Title\r\n\r\nBody.\r\n';
  const parsed = parseFrontMatter(crlf);
  assert.deepEqual(parsed.attributes, { summary: 'S' });
  assert.equal(parsed.body, '# Title\n\nBody.\n');
});

// --- seeding --------------------------------------------------------------

test('pages seed: front matter lands on PageCreated and leaves the body', async () => {
  const pagesDir = await tempDir('page-blocks-content-');
  await fs.writeFile(
    path.join(pagesDir, 'this-site.md'),
    [
      '---',
      'summary: Seven guitar finishes over an event-sourced CMS.',
      'image: asset:maintainer',
      '---',
      '# This Site',
      '',
      'The most honest portfolio piece is the one you are standing in.',
      '',
    ].join('\n'),
  );
  // No front matter: unchanged behaviour, and no metadata keys on the event.
  await fs.writeFile(
    path.join(pagesDir, 'about.md'),
    '# About Me\n\nFirst paragraph.\n',
  );
  // Front matter the API would reject: the page seeds, the field is dropped.
  await fs.writeFile(
    path.join(pagesDir, 'sketchy.md'),
    [
      '---',
      'image: javascript:alert(1)',
      `summary: ${'x'.repeat(SUMMARY_MAX_LENGTH + 1)}`,
      '---',
      '# Sketchy',
      '',
      'Body.',
    ].join('\n'),
  );

  const storeDir = await tempDir('page-blocks-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const service = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  const site = service.getAny('this-site');
  assert.equal(site.title, 'This Site');
  assert.equal(
    site.summary,
    'Seven guitar finishes over an event-sourced CMS.',
  );
  assert.equal(site.image, 'asset:maintainer');
  assert.equal(
    site.body,
    'The most honest portfolio piece is the one you are standing in.',
    'front matter is stripped from the body, heading rule still applies',
  );

  const about = service.getAny('about');
  assert.equal(about.title, 'About Me');
  assert.equal(about.body, 'First paragraph.');
  assert.equal(about.summary, undefined);
  assert.equal(about.image, undefined);

  const sketchy = service.getAny('sketchy');
  assert.equal(sketchy.title, 'Sketchy');
  assert.equal(sketchy.body, 'Body.');
  assert.equal(sketchy.image, undefined, 'javascript: image dropped');
  assert.equal(sketchy.summary, undefined, 'over-long summary dropped');

  // The metadata is in the log, not just in memory: replay reproduces it,
  // and pages without metadata carry no empty keys.
  const created = (await readEvents(storePath)).filter(
    (event) => event.type === PAGE_CREATED,
  );
  const bySlug = new Map(
    created.map((event) => [
      (event.data as { slug: string }).slug,
      event.data as Record<string, unknown>,
    ]),
  );
  assert.deepEqual(Object.keys(bySlug.get('about')!).sort(), [
    'body',
    'slug',
    'title',
  ]);
  assert.deepEqual(Object.keys(bySlug.get('this-site')!).sort(), [
    'body',
    'image',
    'slug',
    'summary',
    'title',
  ]);

  const rebooted = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await rebooted.onModuleInit();
  });
  assert.deepEqual(rebooted.getAny('this-site'), site, 'replay reproduces it');

  // Public list entries carry the card metadata (and only when present).
  const list = rebooted.listPublished();
  const listed = list.find((page) => page.slug === 'this-site')!;
  assert.deepEqual(Object.keys(listed).sort(), [
    'image',
    'publishedAt',
    'slug',
    'summary',
    'title',
  ]);
  assert.equal(listed.image, 'asset:maintainer');
  assert.deepEqual(
    Object.keys(list.find((page) => page.slug === 'about')!).sort(),
    ['publishedAt', 'slug', 'title'],
  );
});

// --- validation -----------------------------------------------------------

test('summary/image validation: https and asset tokens in, unsafe out', () => {
  const ok = (image: string) =>
    assert.equal(
      validateNewPage({ title: 'T', body: 'b', image }).image,
      image,
      `${image} should be accepted`,
    );
  ok('https://cdn.example.com/shot.png');
  ok('https://example.com/a.png?v=2#x');
  ok('asset:maintainer');
  ok('asset:guitar-shelf-2');

  const rejected = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'http://example.com/a.png',
    'data:image/png;base64,AAAA',
    '//example.com/a.png',
    '/assets/a.png',
    'asset:Maintainer',
    'asset:with space',
    'asset:',
    'https://',
    'https://exa mple.com/a.png',
    7 as unknown as string,
  ];
  for (const image of rejected) {
    assert.throws(
      () => validateNewPage({ title: 'T', body: 'b', image }),
      BadRequestException,
      `${String(image)} should be rejected`,
    );
    assert.throws(
      () => validatePageRevision({ image }),
      BadRequestException,
      `${String(image)} should be rejected on revise`,
    );
  }

  // Summary: trimmed, capped at 300 characters.
  assert.equal(
    validateNewPage({ title: 'T', body: 'b', summary: '  Short.  ' }).summary,
    'Short.',
  );
  const max = 'x'.repeat(SUMMARY_MAX_LENGTH);
  assert.equal(
    validateNewPage({ title: 'T', body: 'b', summary: max }).summary,
    max,
    'exactly 300 characters is fine',
  );
  assert.throws(
    () => validateNewPage({ title: 'T', body: 'b', summary: `${max}x` }),
    BadRequestException,
    '301 characters is 400',
  );
  assert.throws(
    () => validatePageRevision({ summary: `${max}x` }),
    BadRequestException,
  );
  assert.throws(
    () => validateNewPage({ title: 'T', body: 'b', summary: 12 }),
    BadRequestException,
  );

  // Absent metadata stays absent — no empty keys on the create input.
  assert.deepEqual(validateNewPage({ title: 'T', body: 'b' }), {
    title: 'T',
    body: 'b',
    draft: false,
  });
  assert.deepEqual(
    validateNewPage({ title: 'T', body: 'b', summary: '  ', image: '' }),
    { title: 'T', body: 'b', draft: false },
    'blank metadata on create is simply absent',
  );

  // On revise, '' is a real change: it clears the field.
  assert.deepEqual(validatePageRevision({ summary: '', image: '' }), {
    summary: '',
    image: '',
  });
  assert.deepEqual(
    validatePageRevision({ summary: ' Deck. ', image: 'asset:maintainer' }),
    { summary: 'Deck.', image: 'asset:maintainer' },
  );
});

// --- revising -------------------------------------------------------------

test('PATCH revises summary and image, and clears them with ""', async () => {
  const storeDir = await tempDir('page-blocks-revise-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const pages = makeService(storePath);

  const created = await pages.createPage(
    validateNewPage({
      title: 'Eleva Platform',
      body: 'v1',
      summary: 'A school platform that powers itself down.',
      image: 'asset:maintainer',
    }),
  );
  assert.equal(created.summary, 'A school platform that powers itself down.');
  assert.equal(created.image, 'asset:maintainer');

  // Revising one field leaves the other alone.
  const revised = await pages.revisePage(
    'eleva-platform',
    validatePageRevision({ summary: 'Event-first on AWS, honest about its bill.' }),
  );
  assert.equal(revised.summary, 'Event-first on AWS, honest about its bill.');
  assert.equal(revised.image, 'asset:maintainer');
  assert.equal(revised.body, 'v1');

  const reimaged = await pages.revisePage(
    'eleva-platform',
    validatePageRevision({ image: 'https://cdn.example.com/eleva.png' }),
  );
  assert.equal(reimaged.image, 'https://cdn.example.com/eleva.png');

  // '' clears: the key goes away entirely rather than turning into ''.
  const cleared = await pages.revisePage(
    'eleva-platform',
    validatePageRevision({ summary: '', image: '' }),
  );
  assert.equal('summary' in cleared, false);
  assert.equal('image' in cleared, false);

  // Metadata-only PATCH is a valid revision; nonsense is still 400.
  assert.throws(() => validatePageRevision({}), BadRequestException);
  assert.deepEqual(
    (await readEvents(storePath)).map((event) => event.type),
    [
      'PageCreated',
      'PagePublished',
      'PageRevised',
      'PageRevised',
      'PageRevised',
    ],
  );

  // Replay reproduces the cleared state exactly (no restart magic).
  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }
  assert.deepEqual(projection.get('eleva-platform'), cleared);
});

// --- projection -----------------------------------------------------------

test('projection carries summary/image through publish and unpublish', async () => {
  const storeDir = await tempDir('page-blocks-projection-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const store = new FileEventStore(storePath);

  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: {
      slug: 'infra-control-panel',
      title: 'Infra Control Panel',
      body: 'Power buttons included.',
      summary: 'Draws the architecture live from CloudFormation.',
      image: 'asset:maintainer',
    },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-02T00:00:00.000Z',
    data: {
      slug: 'infra-control-panel',
      publishedAt: '2026-08-02T00:00:00.000Z',
    },
  });
  await store.append({
    type: PAGE_UNPUBLISHED,
    at: '2026-08-03T00:00:00.000Z',
    data: { slug: 'infra-control-panel', at: '2026-08-03T00:00:00.000Z' },
  });
  await store.append({
    type: PAGE_REVISED,
    at: '2026-08-04T00:00:00.000Z',
    data: { slug: 'infra-control-panel', changes: { body: 'Rewritten.' } },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-05T00:00:00.000Z',
    data: {
      slug: 'infra-control-panel',
      publishedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }

  const page = projection.get('infra-control-panel')!;
  assert.equal(page.status, 'published');
  assert.equal(page.body, 'Rewritten.');
  assert.equal(page.summary, 'Draws the architecture live from CloudFormation.');
  assert.equal(page.image, 'asset:maintainer');
  assert.deepEqual(projection.listPublished()[0], page);

  // A page without metadata keeps the keys absent rather than empty, which
  // is what lets a card decide to fall back.
  const bare = new PagesProjection();
  bare.apply({
    seq: 1,
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'now', title: 'Now', body: 'On the bench.' },
  });
  const view = bare.get('now')!;
  assert.equal('summary' in view, false);
  assert.equal('image' in view, false);
  assert.deepEqual(Object.keys(view).sort(), [
    'body',
    'slug',
    'status',
    'title',
    'updatedAt',
  ]);
});
