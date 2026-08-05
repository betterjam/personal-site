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
import { validateNewPage, validatePageRevision } from '../src/pages/validate';

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

// --- validation -----------------------------------------------------------

test('repo validation: owner/name in, anything that could bend a URL out', () => {
  const accepted = [
    'betterjam/eleva-aws-infra-control',
    'a/b',
    'octocat/Hello-World',
    'diego_v/site.v2',
    'octocat/.github',
    `${'o'.repeat(39)}/${'n'.repeat(100)}`,
  ];
  for (const repo of accepted) {
    assert.equal(
      validateNewPage({ title: 'T', body: 'b', repo }).repo,
      repo,
      `${repo} should be accepted`,
    );
    assert.deepEqual(validatePageRevision({ repo }), { repo });
  }

  const rejected = [
    'a/b/c', // a third segment could point the proxy somewhere else
    'owner name/repo',
    'owner/repo name',
    ' /repo',
    '../',
    '../..', // pattern-legal, traversal-shaped: rejected on top of the regex
    './.',
    '/repo',
    'owner/',
    'owner',
    'owner//repo',
    'https://github.com/owner/repo',
    'owner%2Frepo',
    'owner/repo?tab=readme',
    'owner/repo#x',
    'owner:repo',
    `${'o'.repeat(40)}/repo`,
    `owner/${'n'.repeat(101)}`,
    7 as unknown as string,
    null as unknown as string,
  ];
  for (const repo of rejected) {
    assert.throws(
      () => validateNewPage({ title: 'T', body: 'b', repo }),
      BadRequestException,
      `${String(repo)} should be rejected on create`,
    );
    assert.throws(
      () => validatePageRevision({ repo }),
      BadRequestException,
      `${String(repo)} should be rejected on revise`,
    );
  }

  // Trimmed, and blank on create is simply absent (nothing to clear yet).
  assert.equal(
    validateNewPage({ title: 'T', body: 'b', repo: '  a/b  ' }).repo,
    'a/b',
  );
  assert.deepEqual(validateNewPage({ title: 'T', body: 'b', repo: '  ' }), {
    title: 'T',
    body: 'b',
    draft: false,
  });

  // On revise, '' is a real change: it clears the field — exactly like
  // summary and image.
  assert.deepEqual(validatePageRevision({ repo: '' }), { repo: '' });
  assert.deepEqual(validatePageRevision({ summary: '', image: '', repo: '' }), {
    summary: '',
    image: '',
    repo: '',
  });
});

// --- front matter ---------------------------------------------------------

test('front matter: repo parses out alongside summary and image', () => {
  const { attributes, body } = parseFrontMatter(
    [
      '---',
      'summary: Power buttons included.',
      'image: asset:maintainer',
      'repo: betterjam/eleva-aws-infra-control',
      '---',
      '# Infra Control Panel',
      '',
      'First paragraph.',
      '',
    ].join('\n'),
  );

  assert.deepEqual(attributes, {
    summary: 'Power buttons included.',
    image: 'asset:maintainer',
    repo: 'betterjam/eleva-aws-infra-control',
  });
  assert.equal(body, '# Infra Control Panel\n\nFirst paragraph.\n');

  // Alone, quoted, key case-insensitive, empty value = absent key.
  assert.deepEqual(parseFrontMatter('---\nrepo: a/b\n---\nB').attributes, {
    repo: 'a/b',
  });
  assert.deepEqual(parseFrontMatter('---\nREPO: "a/b"\n---\nB').attributes, {
    repo: 'a/b',
  });
  assert.deepEqual(parseFrontMatter('---\nrepo:\n---\nB').attributes, {});
  // Still not YAML, and still no error on anything unrecognized.
  assert.deepEqual(
    parseFrontMatter('---\nrepos: a/b\nrepo: c/d\n---\nB').attributes,
    { repo: 'c/d' },
  );
});

test('the demonstration page carries the private repo we have evidence for', async () => {
  // content/pages lives beside the app package; dist-test/test/<file>.js is
  // three levels below it at runtime.
  const file = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'content',
    'pages',
    'infra-control-panel.md',
  );
  const { attributes } = parseFrontMatter(await fs.readFile(file, 'utf8'));
  assert.equal(attributes.repo, 'betterjam/eleva-aws-infra-control');
});

// --- seeding --------------------------------------------------------------

test('pages seed: repo front matter lands on PageCreated; junk is dropped', async () => {
  const pagesDir = await tempDir('page-repo-content-');
  await fs.writeFile(
    path.join(pagesDir, 'infra-control-panel.md'),
    [
      '---',
      'summary: Power buttons included.',
      'repo: betterjam/eleva-aws-infra-control',
      '---',
      '# Infra Control Panel',
      '',
      'It reads, it does not draw.',
      '',
    ].join('\n'),
  );
  // Malformed repo: the page still seeds, the field is dropped (a boot must
  // not die on one bad line).
  await fs.writeFile(
    path.join(pagesDir, 'sketchy.md'),
    '---\nrepo: not a repo/at all\n---\n# Sketchy\n\nBody.\n',
  );
  await fs.writeFile(path.join(pagesDir, 'about.md'), '# About\n\nNo repo.\n');

  const storeDir = await tempDir('page-repo-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const service = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await service.onModuleInit();
  });

  const panel = service.getAny('infra-control-panel');
  assert.equal(panel.repo, 'betterjam/eleva-aws-infra-control');
  assert.equal(panel.summary, 'Power buttons included.');
  assert.equal(panel.body, 'It reads, it does not draw.');
  assert.equal(service.getAny('sketchy').repo, undefined);
  assert.equal(service.getAny('sketchy').body, 'Body.');
  assert.equal(service.getAny('about').repo, undefined);

  // The reference is in the log, not just in memory.
  const created = (await readEvents(storePath)).filter(
    (event) => event.type === PAGE_CREATED,
  );
  const bySlug = new Map(
    created.map((event) => [
      (event.data as { slug: string }).slug,
      event.data as Record<string, unknown>,
    ]),
  );
  assert.deepEqual(Object.keys(bySlug.get('infra-control-panel')!).sort(), [
    'body',
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

  const rebooted = makeService(storePath);
  await withEnv({ PAGES_DIR: pagesDir }, async () => {
    await rebooted.onModuleInit();
  });
  assert.deepEqual(rebooted.getAny('infra-control-panel'), panel);

  // Public reads carry it: the list a showcase renders from, and the page.
  const listed = rebooted
    .listPublished()
    .find((page) => page.slug === 'infra-control-panel')!;
  assert.equal(listed.repo, 'betterjam/eleva-aws-infra-control');
  assert.equal(
    'repo' in rebooted.listPublished().find((page) => page.slug === 'about')!,
    false,
  );
  assert.equal(
    rebooted.getPublished('infra-control-panel').repo,
    'betterjam/eleva-aws-infra-control',
  );
});

// --- revising -------------------------------------------------------------

test('PATCH sets, changes and clears repo without touching the rest', async () => {
  const storeDir = await tempDir('page-repo-revise-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const pages = makeService(storePath);

  const created = await pages.createPage(
    validateNewPage({
      title: 'Infra Control Panel',
      body: 'v1',
      summary: 'Power buttons included.',
      repo: 'betterjam/eleva-aws-infra-control',
    }),
  );
  assert.equal(created.repo, 'betterjam/eleva-aws-infra-control');

  const moved = await pages.revisePage(
    'infra-control-panel',
    validatePageRevision({ repo: 'betterjam/infra-control' }),
  );
  assert.equal(moved.repo, 'betterjam/infra-control');
  assert.equal(moved.summary, 'Power buttons included.', 'summary untouched');
  assert.equal(moved.body, 'v1');

  const cleared = await pages.revisePage(
    'infra-control-panel',
    validatePageRevision({ repo: '' }),
  );
  assert.equal('repo' in cleared, false, 'the key goes away, not to ""');
  assert.equal(cleared.summary, 'Power buttons included.');

  // Replay reproduces the cleared state exactly (no restart magic).
  const projection = new PagesProjection();
  for await (const event of new FileEventStore(storePath).readAll()) {
    projection.apply(event);
  }
  assert.deepEqual(projection.get('infra-control-panel'), cleared);
});

// --- projection -----------------------------------------------------------

test('projection carries repo through publish, unpublish and revise', async () => {
  const storeDir = await tempDir('page-repo-projection-store-');
  const storePath = path.join(storeDir, 'events.jsonl');
  const store = new FileEventStore(storePath);

  await store.append({
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: {
      slug: 'infra-control-panel',
      title: 'Infra Control Panel',
      body: 'Power buttons included.',
      repo: 'betterjam/eleva-aws-infra-control',
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
  assert.equal(
    page.repo,
    'betterjam/eleva-aws-infra-control',
    'a page that went dark and came back keeps its repo',
  );

  // Revised to '' the key is gone; revised again it comes back.
  projection.apply({
    seq: 6,
    type: PAGE_REVISED,
    at: '2026-08-06T00:00:00.000Z',
    data: { slug: 'infra-control-panel', changes: { repo: '' } },
  });
  assert.equal('repo' in projection.get('infra-control-panel')!, false);
  projection.apply({
    seq: 7,
    type: PAGE_REVISED,
    at: '2026-08-07T00:00:00.000Z',
    data: { slug: 'infra-control-panel', changes: { repo: 'a/b' } },
  });
  assert.equal(projection.get('infra-control-panel')!.repo, 'a/b');

  // A page created without one carries no empty key, which is what lets a
  // renderer decide there is no widget to draw.
  const bare = new PagesProjection();
  bare.apply({
    seq: 1,
    type: PAGE_CREATED,
    at: '2026-08-01T00:00:00.000Z',
    data: { slug: 'now', title: 'Now', body: 'On the bench.' },
  });
  assert.deepEqual(Object.keys(bare.get('now')!).sort(), [
    'body',
    'slug',
    'status',
    'title',
    'updatedAt',
  ]);
});
