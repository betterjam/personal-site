#!/usr/bin/env node
/**
 * OPTIMIZE SHOTS — WebP derivatives for the screenshots in
 * frontend/src/assets, written NEXT TO the originals and never instead of
 * them.
 *
 *     node tools/optimize-shots.mjs           # convert what is stale
 *     node tools/optimize-shots.mjs --dry-run # say what it would do
 *     node tools/optimize-shots.mjs --quality 78
 *
 * WHY IT IS A SCRIPT AND NOT A BUILD STEP
 * Encoding WebP needs an encoder, and none of the three this script knows
 * how to drive — the `sharp` npm package, `cwebp` (libwebp), `ffmpeg` — is
 * guaranteed to exist on a given machine. A build that silently produced
 * different output depending on what happened to be installed would be
 * worse than one that never converts, so conversion is an explicit,
 * committed, re-runnable step: run it when you add captures, commit the
 * .webp files beside the .png ones, and the site picks them up.
 *
 * HOW THE SITE PICKS THEM UP — nothing to rewire. frontend's asset
 * registry (src/engine/assets.ts) keys pictures by '<folder>/<name>'
 * WITHOUT the extension and serves the most efficient format on disk
 * (webp > jpeg > png), and vite.config.ts drops a superseded original from
 * the bundle, so `asset:eleva-app/org-chart-editor` starts resolving to
 * the derivative the moment it exists. Content never changes.
 *
 * WHAT IT NEVER TOUCHES
 *   - src/assets/_review — screenshots quarantined for personal or
 *     customer data. They are excluded here exactly as they are excluded
 *     from the glob and from the size manifest;
 *   - the originals themselves. They stay lossless, in the repo, as the
 *     source the derivatives are regenerated from.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'frontend', 'src', 'assets');
const QUARANTINE = '_review';
const SOURCE_EXT = /\.(png|jpe?g)$/i;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const qArg = args.indexOf('--quality');
const QUALITY = qArg >= 0 && args[qArg + 1] ? Number(args[qArg + 1]) : 82;

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB';
}

function has(cmd) {
  const probe = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  return probe.error === undefined;
}

/**
 * `sharp`, wherever it happens to be installed — this script sits at the
 * repo root but the workspaces that would carry it are frontend/ and app/,
 * so all three are asked before giving up on it.
 */
async function loadSharp() {
  for (const base of ['package.json', 'frontend/package.json', 'app/package.json']) {
    try {
      const entry = createRequire(join(ROOT, base)).resolve('sharp');
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod;
    } catch {
      /* not installed here — try the next one */
    }
  }
  return null;
}

/** The first encoder available, or null — the whole script hinges on this. */
async function pickEncoder() {
  const sharp = await loadSharp();
  if (sharp !== null) {
    return {
      name: 'sharp',
      convert: (from, to) => sharp(from).webp({ quality: QUALITY }).toFile(to),
    };
  }
  if (has('cwebp')) {
    return {
      name: 'cwebp',
      convert: async (from, to) => {
        const r = spawnSync('cwebp', ['-quiet', '-q', String(QUALITY), from, '-o', to]);
        if (r.status !== 0) throw new Error('cwebp failed on ' + from);
      },
    };
  }
  if (has('ffmpeg')) {
    return {
      name: 'ffmpeg',
      convert: async (from, to) => {
        const r = spawnSync('ffmpeg', [
          '-loglevel', 'error', '-y', '-i', from,
          '-quality', String(QUALITY), to,
        ]);
        if (r.status !== 0) throw new Error('ffmpeg failed on ' + from);
      },
    };
  }
  return null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === QUARANTINE) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** A derivative is stale when it is missing or older than its original. */
function isStale(source, derivative) {
  try {
    return statSync(derivative).mtimeMs < statSync(source).mtimeMs;
  } catch {
    return true;
  }
}

const sources = walk(ASSETS);
if (sources.length === 0) {
  console.log('no PNG/JPEG captures under frontend/src/assets — nothing to do');
  process.exit(0);
}

const encoder = await pickEncoder();
if (encoder === null) {
  console.log(
    'no WebP encoder on this machine — looked for the `sharp` npm package, `cwebp` and `ffmpeg`.',
  );
  console.log(
    `${sources.length} captures (${kb(sources.reduce((n, f) => n + sizeOf(f), 0))}) ship as-is; ` +
      'install one of the three and re-run to add derivatives.',
  );
  /* NOT an error: shipping the originals is a supported outcome, and CI
     must not fail because a machine has no encoder */
  process.exit(0);
}

console.log(`encoder: ${encoder.name} · quality ${QUALITY}${dryRun ? ' · dry run' : ''}`);
let before = 0;
let after = 0;
let written = 0;
let skipped = 0;

for (const source of sources) {
  const derivative = source.replace(SOURCE_EXT, '.webp');
  const rel = relative(ROOT, source);
  if (!isStale(source, derivative)) {
    skipped += 1;
    before += sizeOf(source);
    after += sizeOf(derivative);
    continue;
  }
  if (dryRun) {
    console.log(`would write ${relative(ROOT, derivative)} (from ${kb(sizeOf(source))})`);
    written += 1;
    continue;
  }
  try {
    await encoder.convert(source, derivative);
  } catch (err) {
    console.error(`! ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const from = sizeOf(source);
  const to = sizeOf(derivative);
  before += from;
  after += to;
  written += 1;
  const saved = from > 0 ? Math.round(100 - (to / from) * 100) : 0;
  console.log(`${rel}: ${kb(from)} → ${kb(to)} (-${saved}%)`);
}

if (dryRun) {
  console.log(`${written} derivative(s) would be written, ${skipped} already current`);
} else {
  const saved = before > 0 ? Math.round(100 - (after / before) * 100) : 0;
  console.log(
    `${written} written, ${skipped} already current — ${kb(before)} of originals ` +
      `covered by ${kb(after)} of WebP (-${saved}%). Originals kept; commit both.`,
  );
}
