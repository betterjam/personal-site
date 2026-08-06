import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { pageFromSeedFile, type SnapshotPage } from './src/build/pageSeed';

/**
 * Build stamp — a truthful fallback for the under-construction banner when
 * /api/meta is not available yet. `sha` degrades to 'dev' outside a git repo.
 */
function gitShortSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha || 'dev';
  } catch {
    return 'dev';
  }
}

/* ======================================================== asset metadata ===
   src/engine/assets.ts resolves 'asset:<token>' references through a
   import.meta.glob over src/assets — that hands it URLs, and nothing else.
   The INTRINSIC SIZE of each capture is what stops a hero shot from
   reflowing the reading room the instant it decodes, so this plugin reads
   it straight out of the file headers at build (and dev) time and serves it
   as a virtual module. Nothing is generated into the repo: the manifest is
   recomputed from the files themselves and can never go stale.

   src/assets/_review holds screenshots quarantined for personal data. It is
   excluded HERE as well as in the glob — the exclusion lives in every place
   that walks this tree, never in only one of them. */

const ASSETS_DIR = fileURLToPath(new URL('./src/assets', import.meta.url));
const ASSETS_MARK = 'src/assets/';
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;
/** Formats a .webp derivative supersedes (see tools/optimize-shots.mjs). */
const SUPERSEDABLE = /\.(png|jpe?g)$/i;
const QUARANTINE = '_review';
const VIRTUAL_ID = 'virtual:asset-meta';

/** [width, height] from a PNG's IHDR, or null when the bytes disagree. */
function pngSize(buf: Buffer): [number, number] | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** [width, height] from a JPEG SOF segment (the first one wins). */
function jpegSize(buf: Buffer): [number, number] | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    /* SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame */
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** [width, height] from a RIFF/WEBP chunk — simple, lossless or extended. */
function webpSize(buf: Buffer): [number, number] | null {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (fourcc === 'VP8X') {
    return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  }
  return null;
}

function imageSize(file: string): [number, number] | null {
  try {
    /* the header is all we read — 64 bytes covers every case above except
       a JPEG whose SOF sits behind a fat EXIF block, so take a comfortable
       slice and stop there */
    const buf = readFileSync(file).subarray(0, 65536);
    if (/\.png$/i.test(file)) return pngSize(buf);
    if (/\.webp$/i.test(file)) return webpSize(buf);
    return jpegSize(buf);
  } catch {
    return null;
  }
}

/** Every shippable image under src/assets, relative-path keyed. */
function walkAssets(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === QUARANTINE) continue; /* never ships, never measured */
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkAssets(full, out);
    else if (IMAGE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Serves `virtual:asset-meta` — { 'eleva-app/org-chart-editor.png': [w, h] }
 * keyed by the path relative to src/assets, with '/' separators on every
 * platform. Also the ONE build-time voice for the bare-alias collision the
 * token rule drops: two files with the same basename in different folders
 * are only reachable by their qualified tokens, and that is worth saying
 * once in the build log rather than only in a browser console.
 */
function assetMeta(): Plugin {
  return {
    name: 'diego-site:asset-meta',
    resolveId(id) {
      return id === VIRTUAL_ID ? '\0' + VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== '\0' + VIRTUAL_ID) return null;
      const files = walkAssets(ASSETS_DIR);
      const meta: Record<string, [number, number]> = {};
      /* bare name → the qualified TOKENS that claim it. Keyed by token, not
         by file: one picture in two formats is one token, not a clash. */
      const byBase = new Map<string, Set<string>>();
      for (const file of files) {
        const key = relative(ASSETS_DIR, file).split(/[\\/]/).join('/');
        const size = imageSize(file);
        if (size) meta[key] = size;
        else this.warn(`asset-meta: could not read the intrinsic size of ${key}`);
        const token = key.replace(IMAGE_EXT, '');
        const base = token.replace(/^.*\//, '');
        const claims = byBase.get(base) ?? new Set<string>();
        claims.add(token);
        byBase.set(base, claims);
      }
      for (const [base, tokens] of byBase) {
        if (tokens.size > 1) {
          this.warn(
            `asset token collision: '${base}' names ${tokens.size} pictures ` +
              `(${[...tokens].sort().join(', ')}) — the bare alias is dropped; ` +
              'reference these by their qualified <folder>/<name> tokens',
          );
        }
      }
      return `export default ${JSON.stringify(meta)};\n`;
    },
    /**
     * ONE token, ONE emitted file. tools/optimize-shots.mjs writes WebP
     * derivatives NEXT TO the originals (the lossless source stays in the
     * repo), and src/engine/assets.ts serves the most efficient format on
     * disk — so a PNG that has a .webp sibling is referenced by nothing
     * and would ship as pure dead weight. It is dropped here rather than
     * shipped: a megabyte nobody requests is still a megabyte deployed.
     *
     * With no derivatives on disk this hook does nothing at all.
     */
    generateBundle(_options, bundle) {
      for (const [key, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'asset') continue;
        const sources: readonly string[] = chunk.originalFileNames ?? [];
        for (const from of sources) {
          const at = from.replace(/\\/g, '/').indexOf(ASSETS_MARK);
          if (at < 0 || !SUPERSEDABLE.test(from)) continue;
          const rel = from.replace(/\\/g, '/').slice(at + ASSETS_MARK.length);
          const derivative = join(ASSETS_DIR, ...rel.replace(SUPERSEDABLE, '.webp').split('/'));
          if (!existsSync(derivative)) continue;
          this.info(`superseded by its .webp derivative, not shipped: ${rel}`);
          delete bundle[key];
          break;
        }
      }
    },
  };
}

/* ====================================================== page snapshot ===
   THE FLOOR THE SITE STANDS ON WHEN THE API IS OFF.

   This site is designed to run with its infrastructure switched off — the
   public control plane at control.diegopalominos.dev lets a visitor stop
   it like turning off a light. Section rows, the reading room and the
   markdown '!page[…]' embeds all read their copy from /api/pages/<slug>,
   so with the API stopped the site used to delete its own Projects
   section. It must instead stay FULLY READABLE and merely become richer
   when the API answers.

   Every page already lives in the repo at content/pages/*.md — the very
   corpus the API seeds itself from on first boot. This plugin parses those
   files with the SERVER's semantics (src/build/pageSeed.ts) and serves
   them as `virtual:page-snapshot`: a plain, build-time array, no runtime
   fetch, no top-level await, no Markdown parser shipped to the browser.
   src/engine/snapshot.ts lifts it into the API's own PageView shape.

   Nothing is generated into the repo: the snapshot is recomputed from the
   files themselves on every build and can never go stale. */

const PAGES_DIR = fileURLToPath(new URL('../content/pages', import.meta.url));
const PAGES_VIRTUAL_ID = 'virtual:page-snapshot';
const PAGES_RESOLVED_ID = '\0' + PAGES_VIRTUAL_ID;

function pageSnapshot(): Plugin {
  return {
    name: 'diego-site:page-snapshot',
    resolveId(id) {
      return id === PAGES_VIRTUAL_ID ? PAGES_RESOLVED_ID : null;
    },
    load(id) {
      if (id !== PAGES_RESOLVED_ID) return null;
      let names: string[];
      try {
        names = readdirSync(PAGES_DIR);
      } catch {
        /* no pages directory is a real state — an empty snapshot, and the
           site simply has no floor to fall back to */
        this.warn(`page-snapshot: no pages directory at ${PAGES_DIR} — snapshot is empty`);
        return 'export default [];\n';
      }
      /* filename order, exactly like the seeder's, so the bundled corpus
         and the seeded log are the same corpus in the same order */
      const files = names.filter((name) => name.endsWith('.md')).sort();
      const pages: SnapshotPage[] = [];
      let bytes = 0;
      for (const file of files) {
        const full = join(PAGES_DIR, file);
        this.addWatchFile(full); /* dev: editing a page reloads the snapshot */
        const raw = readFileSync(full, 'utf8');
        bytes += raw.length;
        const { page, warnings } = pageFromSeedFile(file.slice(0, -'.md'.length), raw);
        for (const warning of warnings) this.warn(`page-snapshot: ${warning}`);
        pages.push(page);
      }
      this.info(
        `page-snapshot: ${pages.length} page(s), ${(bytes / 1024).toFixed(1)} kB of authored Markdown`,
      );
      return `export default ${JSON.stringify(pages)};\n`;
    },
    /* a page added, renamed or deleted while `vite dev` runs is a new
       snapshot — invalidate the virtual module and reload the page */
    configureServer(server) {
      server.watcher.add(PAGES_DIR);
      const touched = (file: string): void => {
        const path = file.replace(/\\/g, '/');
        if (!path.endsWith('.md') || !path.includes('/content/pages/')) return;
        const mod = server.moduleGraph.getModuleById(PAGES_RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', touched);
      server.watcher.on('unlink', touched);
    },
  };
}

export default defineConfig({
  plugins: [assetMeta(), pageSnapshot()],
  build: {
    outDir: '../app/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
    fs: {
      // content/ and themes/ JSON live one level above the vite root.
      allow: ['..'],
    },
  },
  define: {
    __BUILD_INFO__: JSON.stringify({
      sha: gitShortSha(),
      builtAt: new Date().toISOString(),
    }),
  },
});
