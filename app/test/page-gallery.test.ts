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
import { parseFrontMatter, parseGalleryList } from '../src/pages/front-matter';
import { PagesProjection } from '../src/pages/pages.projection';
import { PagesService } from '../src/pages/pages.service';
import {
  GALLERY_MAX_ENTRIES,
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

// --- front matter ---------------------------------------------------------

test('front matter: gallery is a comma-separated list with optional |captions', () => {
  const { attributes, body } = parseFrontMatter(
    [
      '---',
      'summary: A multitenant SaaS for schools.',
      'image: asset:eleva-app/process-results-report',
      'repo: example-org/example-repo',
      'gallery: asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/question-bank-catalog|Question bank',
      '---',
      '# Eleva Platform',
      '',
      'First paragraph.',
      '',
    ].join('\n'),
  );

  assert.deepEqual(attributes, {
    summary: 'A multitenant SaaS for schools.',
    image: 'asset:eleva-app/process-results-report',
    repo: 'example-org/example-repo',
    gallery: [
      { ref: 'asset:eleva-app/org-chart-editor', caption: 'Org chart editor' },
      { ref: 'asset:eleva-app/question-bank-catalog', caption: 'Question bank' },
    ],
  });
  assert.equal(body, '# Eleva Platform\n\nFirst paragraph.\n');
});

test('front matter: gallery whitespace, missing captions and mixed refs', () => {
  // Ragged whitespace around items, refs and captions is all trimmed; an
  // item with no pipe simply has no caption; https refs sit next to assets.
  assert.deepEqual(
    parseGalleryList(
      '  asset:a-folder/one   |   First shot  ,asset:two,   https://cdn.example.com/three.png|  Third  ',
    ),
    [
      { ref: 'asset:a-folder/one', caption: 'First shot' },
      { ref: 'asset:two' },
      { ref: 'https://cdn.example.com/three.png', caption: 'Third' },
    ],
  );

  // Only the FIRST pipe splits, so a caption may hold further pipes.
  assert.deepEqual(parseGalleryList('asset:a|Stages | overridable per school'), [
    { ref: 'asset:a', caption: 'Stages | overridable per school' },
  ]);

  // A caption may hold commas: a comma starts the next entry only when what
  // follows it opens a reference.
  assert.deepEqual(
    parseGalleryList(
      'asset:one|Live docs, generated from the modules themselves, asset:two|Second, third clause, https://cdn.example.com/x.png',
    ),
    [
      {
        ref: 'asset:one',
        caption: 'Live docs, generated from the modules themselves',
      },
      { ref: 'asset:two', caption: 'Second, third clause' },
      { ref: 'https://cdn.example.com/x.png' },
    ],
  );
  // Without a caption open, a comma always splits — so a run of plain refs
  // is never glued together.
  assert.deepEqual(
    parseGalleryList('asset:one, asset:two, asset:three').map((e) => e.ref),
    ['asset:one', 'asset:two', 'asset:three'],
  );

  // Order is authored order, kept exactly.
  assert.deepEqual(
    parseGalleryList('asset:c, asset:a, asset:b').map((entry) => entry.ref),
    ['asset:c', 'asset:a', 'asset:b'],
  );
});

test('front matter: an empty or malformed gallery is absent, never an error', () => {
  // Empty value = absent key, exactly like the single-value keys.
  assert.deepEqual(parseFrontMatter('---\ngallery:\n---\nB').attributes, {});
  assert.deepEqual(parseFrontMatter('---\ngallery:    \n---\nB').attributes, {});
  // Nothing but separators, or captions with no ref: noise, not entries.
  assert.deepEqual(parseFrontMatter('---\ngallery: , , ,\n---\nB').attributes, {});
  assert.deepEqual(
    parseFrontMatter('---\ngallery: |orphan caption\n---\nB').attributes,
    {},
  );
  assert.deepEqual(parseGalleryList(''), []);
  assert.deepEqual(parseGalleryList('|a|b'), []);

  // Malformed entries are dropped one by one; the good ones still seed.
  assert.deepEqual(
    parseGalleryList('asset:good, , |no ref, asset:also-good|Caption'),
    [{ ref: 'asset:good' }, { ref: 'asset:also-good', caption: 'Caption' }],
  );

  // Quoted whole value, key case-insensitivity and unknown keys: unchanged
  // behaviour, now with a list-valued key in the block.
  assert.deepEqual(
    parseFrontMatter('---\nGALLERY: "asset:a|One, asset:b"\n---\nB').attributes,
    { gallery: [{ ref: 'asset:a', caption: 'One' }, { ref: 'asset:b' }] },
  );
  assert.deepEqual(
    parseFrontMatter('---\ngalleries: asset:x\ngallery: asset:y\n---\nB')
      .attributes,
    { gallery: [{ ref: 'asset:y' }] },
  );

  // No front matter at all: the body is untouched and there is no gallery.
  const plain = parseFrontMatter('# About\n\ngallery: asset:not-front-matter\n');
  assert.deepEqual(plain.attributes, {});
  assert.equal(plain.body, '# About\n\ngallery: asset:not-front-matter\n');
});

test('every gallery ref in content/pages is one the API would accept', async () => {
  // content/pages lives beside the app package; dist-test/test/<file>.js is
  // three levels below it at runtime.
  const dir = path.resolve(__dirname, '..', '..', '..', 'content', 'pages');
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.md'));
  assert.ok(files.length > 0, 'the repo ships authored pages');

  let withGallery = 0;
  for (const file of files) {
    const { attributes } = parseFrontMatter(
      await fs.readFile(path.join(dir, file), 'utf8'),
    );
    if (attributes.gallery === undefined) continue;
    withGallery += 1;
    assert.ok(
      attributes.gallery.length <= GALLERY_MAX_ENTRIES,
      `${file} is within the ${GALLERY_MAX_ENTRIES}-entry cap`,
    );
    for (const entry of attributes.gallery) {
      // The API's rule, applied to what the seeder will read: a ref the
      // validator would 400 on would be dropped at boot instead of shown.
      assert.doesNotThrow(
        () =>
          validateNewPage({ title: 'T', body: 'b', gallery: [{ ref: entry.ref }] }),
        `${file}: ${entry.ref} must be a valid reference`,
      );
    }
  }
  assert.ok(withGallery > 0, 'at least one authored page carries a gallery');
});

// --- validation -----------------------------------------------------------

test('gallery validation: asset and https refs in, anything else out', () => {
  const accepted = [
    'asset:maintainer',
    'asset:eleva-app/org-chart-editor',
    'asset:rolling-garage-landing/landing-hero-and-about',
    'https://cdn.example.com/shot.png',
  ];
  for (const ref of accepted) {
    assert.deepEqual(
      validateNewPage({ title: 'T', body: 'b', gallery: [{ ref }] }).gallery,
      [{ ref }],
      `${ref} should be accepted`,
    );
    assert.deepEqual(validatePageRevision({ gallery: [{ ref }] }), {
      gallery: [{ ref }],
    });
  }

  const rejected = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'http://cdn.example.com/shot.png',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/shot.png',
    '/assets/shot.png',
    'asset:../../etc/passwd',
    'asset:eleva-app/nested/deeper',
    'asset:Eleva-App/Org-Chart',
    'asset:',
    'https://cdn.example.com/a shot.png',
    '',
    '   ',
  ];
  for (const ref of rejected) {
    assert.throws(
      () => validateNewPage({ title: 'T', body: 'b', gallery: [{ ref }] }),
      BadRequestException,
      `${ref} should be rejected on create`,
    );
    assert.throws(
      () => validatePageRevision({ gallery: [{ ref }] }),
      BadRequestException,
      `${ref} should be rejected on revise`,
    );
  }

  // An entry is an object with a ref (a bare string is the caption-less
  // shorthand); captions are trimmed and a blank one is dropped, never
  // stored as ''.
  assert.deepEqual(
    validateNewPage({
      title: 'T',
      body: 'b',
      gallery: [
        { ref: '  asset:one  ', caption: '  First shot  ' },
        { ref: 'asset:two', caption: '   ' },
        'asset:three',
      ],
    }).gallery,
    [
      { ref: 'asset:one', caption: 'First shot' },
      { ref: 'asset:two' },
      { ref: 'asset:three' },
    ],
  );
  assert.throws(
    () => validateNewPage({ title: 'T', body: 'b', gallery: [{ caption: 'x' }] }),
    BadRequestException,
    'an entry with no ref is a 400',
  );
  assert.throws(
    () =>
      validateNewPage({
        title: 'T',
        body: 'b',
        gallery: [{ ref: 'asset:one', caption: 7 }],
      }),
    BadRequestException,
    'a non-string caption is a 400',
  );
});

test('gallery validation: non-arrays and over-long strips are 400', () => {
  for (const gallery of [
    'asset:one',
    7,
    null,
    { ref: 'asset:one' },
    { 0: { ref: 'asset:one' }, length: 1 },
  ]) {
    assert.throws(
      () => validateNewPage({ title: 'T', body: 'b', gallery }),
      BadRequestException,
      `${JSON.stringify(gallery)} is not an array`,
    );
    assert.throws(
      () => validatePageRevision({ gallery }),
      BadRequestException,
    );
  }

  const atCap = Array.from({ length: GALLERY_MAX_ENTRIES }, (_, i) => ({
    ref: `asset:shot-${i}`,
  }));
  assert.equal(
    validateNewPage({ title: 'T', body: 'b', gallery: atCap }).gallery!.length,
    GALLERY_MAX_ENTRIES,
    'exactly the cap is fine',
  );
  const overCap = [...atCap, { ref: 'asset:one-too-many' }];
  assert.throws(
    () => validateNewPage({ title: 'T', body: 'b', gallery: overCap }),
    BadRequestException,
    `${GALLERY_MAX_ENTRIES + 1} entries is a 400`,
  );
  assert.throws(
    () => validatePageRevision({ gallery: overCap }),
    BadRequestException,
  );

  // [] is legal: on create it is simply no gallery, on revise it clears one.
  assert.deepEqual(validateNewPage({ title: 'T', body: 'b', gallery: [] }), {
    title: 'T',
    body: 'b',
    draft: false,
  });
  assert.deepEqual(validatePageRevision({ gallery: [] }), { gallery: [] });
});

// --- projection -----------------------------------------------------------

test('projection carries gallery through publish, unpublish and revise', async () => {
  const storeDir = await tempDir('page-gallery-projection-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const store = new FileEventStore(storePath);
  const shots = [
    { ref: 'asset:eleva-app/org-chart-editor', caption: 'Org chart editor' },
    { ref: 'asset:eleva-app/question-bank-catalog' },
  ];

  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: {
      slug: 'eleva-platform',
      title: 'Eleva Platform',
      body: 'Built since 2017.',
      gallery: shots,
    },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-02T00:00:00.000Z',
    data: { slug: 'eleva-platform', publishedAt: '2026-08-02T00:00:00.000Z' },
  });
  await store.append({
    type: PAGE_UNPUBLISHED,
    at: '2026-08-03T00:00:00.000Z',
    data: { slug: 'eleva-platform', at: '2026-08-03T00:00:00.000Z' },
  });
  await store.append({
    type: PAGE_REVISED,
    at: '2026-08-04T00:00:00.000Z',
    data: { slug: 'eleva-platform', changes: { body: 'Rewritten.' } },
  });
  await store.append({
    type: PAGE_PUBLISHED,
    at: '2026-08-05T00:00:00.000Z',
    data: { slug: 'eleva-platform', publishedAt: '2026-08-05T00:00:00.000Z' },
  });

  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }
  const page = projection.get('eleva-platform')!;
  assert.equal(page.status, 'published');
  assert.equal(page.body, 'Rewritten.');
  assert.deepEqual(
    page.gallery,
    shots,
    'a page that went dark and came back keeps its pictures, in order',
  );

  // Revising the gallery replaces the whole strip.
  projection.apply({
    seq: 6,
    type: PAGE_REVISED,
    at: '2026-08-06T00:00:00.000Z',
    data: {
      slug: 'eleva-platform',
      changes: { gallery: [{ ref: 'asset:eleva-landing/eleva-landing-hero' }] },
    },
  });
  assert.deepEqual(projection.get('eleva-platform')!.gallery, [
    { ref: 'asset:eleva-landing/eleva-landing-hero' },
  ]);

  // [] clears it: the key goes away, it does not become an empty array.
  projection.apply({
    seq: 7,
    type: PAGE_REVISED,
    at: '2026-08-07T00:00:00.000Z',
    data: { slug: 'eleva-platform', changes: { gallery: [] } },
  });
  assert.equal('gallery' in projection.get('eleva-platform')!, false);
  assert.equal(projection.get('eleva-platform')!.body, 'Rewritten.');

  // And it comes back on the next revision.
  projection.apply({
    seq: 8,
    type: PAGE_REVISED,
    at: '2026-08-08T00:00:00.000Z',
    data: { slug: 'eleva-platform', changes: { gallery: shots } },
  });
  assert.deepEqual(projection.get('eleva-platform')!.gallery, shots);

  // A page created without one carries no empty key, which is what lets a
  // renderer decide there is no grid to draw. Junk entries in a
  // hand-written event are dropped rather than folded in.
  const bare = new PagesProjection();
  bare.apply({
    seq: 1,
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'now', title: 'Now', body: 'On the bench.', gallery: [] },
  });
  assert.deepEqual(Object.keys(bare.get('now')!).sort(), [
    'body',
    'slug',
    'status',
    'title',
    'updatedAt',
  ]);
  bare.apply({
    seq: 2,
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: {
      slug: 'junk',
      title: 'Junk',
      body: 'b',
      gallery: [null, { caption: 'no ref' }, { ref: '  ' }, { ref: 'asset:ok' }],
    },
  });
  assert.deepEqual(bare.get('junk')!.gallery, [{ ref: 'asset:ok' }]);
});

test('page create and revise put the gallery in the log and take it back out', async () => {
  const storeDir = await tempDir('page-gallery-lifecycle-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const pages = makeService(storePath);

  const created = await pages.createPage(
    validateNewPage({
      title: 'Eleva Platform',
      body: 'v1',
      summary: 'A multitenant SaaS for schools.',
      gallery: [
        { ref: 'asset:eleva-app/org-chart-editor', caption: 'Org chart editor' },
        { ref: 'asset:eleva-app/question-bank-catalog' },
      ],
    }),
  );
  assert.deepEqual(created.gallery, [
    { ref: 'asset:eleva-app/org-chart-editor', caption: 'Org chart editor' },
    { ref: 'asset:eleva-app/question-bank-catalog' },
  ]);

  // Public reads carry it: the list and the page itself.
  assert.deepEqual(
    pages.listPublished().find((page) => page.slug === 'eleva-platform')!.gallery,
    created.gallery,
  );
  assert.deepEqual(pages.getPublished('eleva-platform').gallery, created.gallery);

  const swapped = await pages.revisePage(
    'eleva-platform',
    validatePageRevision({
      gallery: [{ ref: 'asset:eleva-landing/eleva-landing-hero' }],
    }),
  );
  assert.deepEqual(swapped.gallery, [
    { ref: 'asset:eleva-landing/eleva-landing-hero' },
  ]);
  assert.equal(swapped.summary, 'A multitenant SaaS for schools.', 'untouched');

  const cleared = await pages.revisePage(
    'eleva-platform',
    validatePageRevision({ gallery: [] }),
  );
  assert.equal('gallery' in cleared, false, 'the key goes away, not to []');
  assert.equal(cleared.summary, 'A multitenant SaaS for schools.');

  // Replay reproduces the cleared state exactly (no restart magic).
  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }
  assert.deepEqual(projection.get('eleva-platform'), cleared);
});

// --- seeding --------------------------------------------------------------

test('fresh store: booting seeds every page with title, body, summary, image, repo AND gallery', async () => {
  const pagesDir = await tempDir('page-gallery-content-');
  await fs.writeFile(
    path.join(pagesDir, 'eleva-platform.md'),
    [
      '---',
      'summary: A multitenant SaaS for schools.',
      'image: asset:eleva-app/process-results-report',
      'repo: example-org/example-repo',
      'gallery: asset:eleva-landing/eleva-landing-hero|eleva.school, asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/question-bank-catalog',
      '---',
      '# Eleva Platform',
      '',
      'Built since 2017.',
      '',
    ].join('\n'),
  );
  // One bad reference costs its own picture, not the page and not the rest
  // of the strip — a boot must never die on one authored line.
  await fs.writeFile(
    path.join(pagesDir, 'sketchy.md'),
    '---\ngallery: javascript:alert(1)|Bad, asset:ok|Good\n---\n# Sketchy\n\nBody.\n',
  );
  await fs.writeFile(path.join(pagesDir, 'about.md'), '# About\n\nNo pictures.\n');

  const storeDir = await tempDir('page-gallery-seed-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  assert.deepEqual(await readEvents(storePath), [], 'fresh store');

  const service = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  // The seeding guarantee: a production deploy against an empty database
  // reproduces the authored page whole.
  const eleva = service.getAny('eleva-platform');
  assert.equal(eleva.title, 'Eleva Platform');
  assert.equal(eleva.body, 'Built since 2017.');
  assert.equal(eleva.summary, 'A multitenant SaaS for schools.');
  assert.equal(eleva.image, 'asset:eleva-app/process-results-report');
  assert.equal(eleva.repo, 'example-org/example-repo');
  assert.equal(eleva.status, 'published');
  assert.deepEqual(eleva.gallery, [
    { ref: 'asset:eleva-landing/eleva-landing-hero', caption: 'eleva.school' },
    { ref: 'asset:eleva-app/org-chart-editor', caption: 'Org chart editor' },
    { ref: 'asset:eleva-app/question-bank-catalog' },
  ]);

  assert.deepEqual(service.getAny('sketchy').gallery, [
    { ref: 'asset:ok', caption: 'Good' },
  ]);
  assert.equal(service.getAny('sketchy').body, 'Body.');
  assert.equal(service.getAny('about').gallery, undefined);

  // The pictures are in the LOG, not just in memory.
  const created = (await readEvents(storePath)).filter(
    (event) => event.type === PAGE_CREATED,
  );
  const bySlug = new Map(
    created.map((event) => [
      (event.data as { slug: string }).slug,
      event.data as Record<string, unknown>,
    ]),
  );
  assert.deepEqual(Object.keys(bySlug.get('eleva-platform')!).sort(), [
    'body',
    'gallery',
    'image',
    'repo',
    'slug',
    'summary',
    'title',
  ]);
  assert.deepEqual(Object.keys(bySlug.get('about')!).sort(), [
    'body',
    'slug',
    'title',
  ]);

  // A reboot replays to exactly the same page, and the public reads a
  // reading room fetches carry the strip.
  const rebooted = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await rebooted.onModuleInit();
  });
  assert.deepEqual(rebooted.getAny('eleva-platform'), eleva);
  assert.deepEqual(
    rebooted.getPublished('eleva-platform').gallery,
    eleva.gallery,
  );
  assert.deepEqual(
    rebooted.listPublished().find((page) => page.slug === 'eleva-platform')!
      .gallery,
    eleva.gallery,
  );
  assert.equal(
    'gallery' in rebooted.listPublished().find((page) => page.slug === 'about')!,
    false,
  );
});

test('pages seed: a gallery longer than the cap keeps its first entries', async () => {
  const pagesDir = await tempDir('page-gallery-cap-content-');
  const refs = Array.from(
    { length: GALLERY_MAX_ENTRIES + 3 },
    (_, i) => `asset:shots/shot-${i}`,
  );
  await fs.writeFile(
    path.join(pagesDir, 'overloaded.md'),
    `---\ngallery: ${refs.join(', ')}\n---\n# Overloaded\n\nBody.\n`,
  );

  const storeDir = await tempDir('page-gallery-cap-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const service = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  const page = service.getAny('overloaded');
  assert.equal(page.gallery!.length, GALLERY_MAX_ENTRIES);
  assert.deepEqual(
    page.gallery!.map((entry) => entry.ref),
    refs.slice(0, GALLERY_MAX_ENTRIES),
    'the first entries survive, the page still seeds',
  );
});
