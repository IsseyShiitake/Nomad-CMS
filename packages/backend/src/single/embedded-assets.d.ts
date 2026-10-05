/**
 * Ambient declaration for the virtual module injected by the single-file
 * build (scripts/build-single.mjs). The module has no on-disk source —
 * esbuild resolves it through a plugin at bundle time — so TypeScript
 * needs this declaration to typecheck src/index-single.ts. Only the
 * single-file bundle imports it; the monorepo Worker never does.
 */
declare module 'virtual:embedded-assets' {
  import type { EmbeddedAssets } from './embedded';
  export const embeddedAssets: EmbeddedAssets;
}
