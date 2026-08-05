import * as path from 'path';

/**
 * Absolute path of the app package root (the directory holding package.json).
 * Compiled layout is <root>/dist/config/paths.js, so two levels up is the root.
 */
export const APP_ROOT = path.resolve(__dirname, '..', '..');

/** Directory holding content.json. Override with CONTENT_DIR. */
export function contentDir(): string {
  return process.env.CONTENT_DIR ?? path.resolve(APP_ROOT, '..', 'content');
}

/** Directory holding authored page Markdown files. Override with PAGES_DIR. */
export function pagesDir(): string {
  return process.env.PAGES_DIR ?? path.resolve(APP_ROOT, '..', 'content', 'pages');
}

/** Directory holding theme JSON files. Override with THEMES_DIR. */
export function themesDir(): string {
  return process.env.THEMES_DIR ?? path.resolve(APP_ROOT, '..', 'themes');
}

/** Append-only blog event log (JSONL). Override with BLOG_EVENTS_PATH. */
export function blogEventsPath(): string {
  return process.env.BLOG_EVENTS_PATH ?? path.resolve(APP_ROOT, 'var', 'blog-events.jsonl');
}

/** Static frontend directory served at /. */
export function publicDir(): string {
  return path.resolve(APP_ROOT, 'public');
}
