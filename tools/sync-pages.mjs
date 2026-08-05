#!/usr/bin/env node
/**
 * Push repo-authored pages into a running site's event log.
 *
 * The seeder only creates a page the first time its slug is seen, so once a
 * page exists, editing its .md changes nothing on a running site. This tool
 * closes that gap: it diffs every content/pages/*.md against the live API and
 * PATCHes the ones that differ, producing normal PageRevised events.
 *
 *   node tools/sync-pages.mjs --dry-run
 *   ADMIN_TOKEN=dev node tools/sync-pages.mjs
 *   API=https://diegopalominos.dev ADMIN_TOKEN=… node tools/sync-pages.mjs about now
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, '..', 'content', 'pages');
const API = (process.env.API || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN || 'dev';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const only = argv.filter((a) => !a.startsWith('--'));

/** Front matter is a leading ---\n…\n--- block of `key: value` lines. */
function parse(raw) {
  let body = raw;
  const fm = {};
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    body = raw.slice(m[0].length);
  }
  let title = null;
  const h1 = body.match(/^#\s+(.+)\n+/);
  if (h1) {
    title = h1[1].trim();
    body = body.slice(h1[0].length);
  }
  return { fm, title, body: body.trim() };
}

/** "asset:a|Cap one, asset:b" -> [{ref,caption?}] — a comma only splits when a ref follows. */
function parseGallery(value) {
  if (!value) return [];
  return value
    .split(/,\s*(?=(?:asset:|https:\/\/))/)
    .map((entry) => {
      const [ref, ...caption] = entry.split('|');
      const e = { ref: ref.trim() };
      const c = caption.join('|').trim();
      if (c) e.caption = c;
      return e;
    })
    .filter((e) => e.ref);
}

const sameGallery = (a = [], b = []) =>
  a.length === b.length &&
  a.every((x, i) => x.ref === b[i].ref && (x.caption || '') === (b[i].caption || ''));

const files = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !only.length || only.includes(f.replace(/\.md$/, '')));

let changed = 0;
let skipped = 0;
let missing = 0;

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const { fm, title, body } = parse(readFileSync(join(PAGES_DIR, file), 'utf8'));

  const res = await fetch(`${API}/api/admin/pages/${slug}`, { headers: { 'x-admin-token': TOKEN } });
  if (res.status === 404) {
    console.log(`  +  ${slug.padEnd(24)} not on the server yet — it seeds on next boot`);
    missing += 1;
    continue;
  }
  if (!res.ok) {
    console.error(`  !  ${slug.padEnd(24)} ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    continue;
  }
  const live = await res.json();

  const wanted = { title, body };
  if (fm.summary) wanted.summary = fm.summary;
  if (fm.image) wanted.image = fm.image;
  if (fm.repo) wanted.repo = fm.repo;
  const gallery = parseGallery(fm.gallery);
  if (gallery.length) wanted.gallery = gallery;

  const diff = Object.entries(wanted).filter(([k, v]) =>
    k === 'gallery' ? !sameGallery(v, live.gallery) : v !== live[k],
  );
  if (!diff.length) {
    skipped += 1;
    continue;
  }

  const fields = diff.map(([k]) => k).join(', ');
  if (DRY) {
    console.log(`  ~  ${slug.padEnd(24)} would update: ${fields}`);
    changed += 1;
    continue;
  }
  const patch = await fetch(`${API}/api/pages/${slug}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(Object.fromEntries(diff)),
  });
  if (patch.ok) {
    console.log(`  ✓  ${slug.padEnd(24)} updated: ${fields}`);
    changed += 1;
  } else {
    console.error(`  !  ${slug.padEnd(24)} ${patch.status} ${await patch.text()}`);
    process.exitCode = 1;
  }
}

console.log(
  `\n${DRY ? 'dry run: ' : ''}${changed} ${DRY ? 'would change' : 'updated'}, ${skipped} already current` +
    (missing ? `, ${missing} awaiting first boot` : ''),
);
