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
