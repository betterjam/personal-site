/// <reference types="vite/client" />

/** Compile-time build stamp injected by vite.config.ts (define). */
declare const __BUILD_INFO__: {
  readonly sha: string;
  readonly builtAt: string;
};

/**
 * Intrinsic sizes of the bundled images, read out of the file headers by
 * the asset-meta plugin in vite.config.ts. Keys are paths relative to
 * src/assets ('eleva-app/org-chart-editor.png'); src/assets/_review is
 * excluded there exactly as it is in the glob. A file whose header could
 * not be read simply has no entry — the renderer falls back to its
 * aspect-ratio box.
 */
declare module 'virtual:asset-meta' {
  const meta: Record<string, [width: number, height: number]>;
  export default meta;
}

/**
 * The BUILD-TIME CONTENT SNAPSHOT: every content/pages/*.md parsed with
 * the server's own front-matter rules by the page-snapshot plugin in
 * vite.config.ts, in filename order. It is the floor the site stands on
 * when the API is switched off — src/engine/snapshot.ts lifts it into the
 * API's PageView shape and src/engine/data.ts falls back to it whenever
 * the API cannot be reached.
 */
declare module 'virtual:page-snapshot' {
  const pages: import('./build/pageSeed').SnapshotPage[];
  export default pages;
}
