/**
 * Theme plumbing lifted from the Mixtape mockup: scoped token application,
 * per-theme accents/stages, weighted swarm swatches, and the little text
 * utilities (abbr/squeeze) the silkscreen renderers share.
 *
 * No hardcoded palette hex here — every color flows out of the theme JSONs.
 */
import { THEMES } from './data';

/* ------------------------------------------------------------ color math */

export type Rgb = [number, number, number];

export function hexRgb(hex: string): Rgb {
  let h = String(hex).replace('#', '');
  if (h.length === 3) {
    h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG) of a hex color. */
export function lum(hex: string): number {
  const c = hexRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Stage luminance where white ink stops beating black ink (WCAG). */
export const INK_FLIP = 0.18;

/**
 * The neutral ink that stays legible over a stage hex — the deck chrome
 * (scroll indicator, scroll hint) pushes this as a scoped custom property
 * so one rule set serves both the cream and the near-black stages.
 * Neutral only: never a palette color.
 */
export function inkOn(stage: string): string {
  return lum(stage) > INK_FLIP ? '#000' : '#fff';
}

/* ----------------------------------------------------------- text utils */

export function kebab(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const STOPWORDS = /^(the|a|an|and|of|is|with|by|at|for|done)$/i;

/**
 * Silkscreen clip for long words: keep the lead, drop interior vowels,
 * collapse doubles — RCNCLTN and BCKPRSR, never RECONCI.
 */
export function squeeze(w: string): string {
  let out = w.charAt(0);
  for (let i = 1; i < w.length; i++) {
    const ch = w.charAt(i);
    if (/[AEIOUY]/.test(ch)) continue;
    if (ch === out.charAt(out.length - 1)) continue;
    out += ch;
  }
  return out.slice(0, 7);
}

export function abbr(title: string): string {
  const words = String(title)
    .split(/[\s:—-]+/)
    .filter((w) => w && !STOPWORDS.test(w));
  /* short prefix on a compound → initials: Anti-corruption layers = ACL */
  if (words.length >= 3 && words[0].length <= 4) {
    return (words[0].charAt(0) + words[1].charAt(0) + words[2].charAt(0)).toUpperCase();
  }
  const w = (words[0] || title).replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  return w.length > 8 ? squeeze(w) : w;
}

/* --------------------------------------- per-theme accents & stage tokens */

export const ACCENT_KEY: Record<string, string> = {
  'seafoam-studio': 'seafoamDeep',
  'candy-particles': 'candy',
  'surf-orbit': 'surfDeep',
  pedalboard: 'surfPedal',
  'event-log': 'glow',
  'sunburst-editorial': 'amber',
};

/** Section-specific accent overrides (the guitars band runs LED red). */
export const SECTION_ACCENT_KEY: Record<string, string> = {
  guitars: 'ledRed',
};

export const STAGE_KEY: Record<string, string> = {
  'seafoam-studio': 'bone',
  'candy-particles': 'stage',
  'surf-orbit': 'canvas',
  pedalboard: 'tolex',
  'event-log': 'stage',
  'sunburst-editorial': 'paper',
};

export function accentOf(themeId: string, sectionId?: string | null): string {
  const key = (sectionId && SECTION_ACCENT_KEY[sectionId]) || ACCENT_KEY[themeId];
  return THEMES[themeId].palette[key];
}

export function stageOf(themeId: string): string {
  return THEMES[themeId].palette[STAGE_KEY[themeId]];
}

/**
 * Scoped tokens: the wrapper is the cascade boundary. Sets --p-<kebab-token>
 * for every palette entry plus font stacks, --accent and --focus. Themes
 * never leak across sections.
 */
export function applyTokens(node: HTMLElement, themeId: string, accentHex: string): void {
  const t = THEMES[themeId];
  for (const k of Object.keys(t.palette)) {
    node.style.setProperty('--p-' + kebab(k), t.palette[k]);
  }
  node.style.setProperty('--font-display', t.type.display.stack);
  node.style.setProperty('--font-body', t.type.body.stack);
  node.style.setProperty('--font-mono', t.type.utility.stack);
  node.style.setProperty('--accent', accentHex);
  node.style.setProperty('--focus', accentHex);
}

/* -------------------------------------------------- swarm swatch palettes */

/** [paletteToken, weight, twinkles] — metallic accents twinkle. */
export type SwatchSpec = [token: string, weight: number, twinkle: boolean];

export const SWATCH_SPECS: Record<string, SwatchSpec[]> = {
  'seafoam-studio': [
    ['seafoam', 0.36, false],
    ['seafoamDeep', 0.3, false],
    ['pine', 0.18, false],
    ['graphite', 0.16, false],
  ],
  'candy-particles': [
    ['candy', 0.38, false],
    ['candyDeep', 0.18, false],
    ['goldBase', 0.22, true],
    ['chrome', 0.1, true],
    ['bone', 0.12, false],
  ],
  'surf-orbit': [
    ['surf', 0.4, false],
    ['surfDeep', 0.24, false],
    ['brass', 0.2, true],
    ['tortoise', 0.16, false],
  ],
  pedalboard: [
    ['surfPedal', 0.24, false],
    ['candyPedal', 0.24, false],
    ['creamPedal', 0.18, false],
    ['burstGold', 0.2, true],
    ['ledRed', 0.14, false],
  ],
  'event-log': [
    ['lakePlacid', 0.4, false],
    ['glow', 0.28, true],
    ['solder', 0.16, false],
    ['ice', 0.16, false],
  ],
  'sunburst-editorial': [
    ['amber', 0.4, true],
    ['tobacco', 0.28, false],
    ['cream', 0.16, false],
    ['burstEdge', 0.16, false],
  ],
};

export interface Swatch {
  rgb: Rgb;
  w: number;
  tw: boolean;
}

function buildSwatches(): Record<string, Swatch[]> {
  const out: Record<string, Swatch[]> = {};
  for (const id of Object.keys(SWATCH_SPECS)) {
    const pal = THEMES[id].palette;
    out[id] = SWATCH_SPECS[id].map(([token, w, tw]) => ({
      rgb: hexRgb(pal[token]),
      w,
      tw,
    }));
  }
  return out;
}

export const SWATCHES: Record<string, Swatch[]> = buildSwatches();

/** Weighted random index into a swatch set. */
export function pickIdx(sw: Swatch[]): number {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < sw.length; i++) {
    acc += sw[i].w;
    if (r <= acc) return i;
  }
  return sw.length - 1;
}
