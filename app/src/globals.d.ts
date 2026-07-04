import type { TopdownManifest } from './core/mesh'

declare global {
  /** public/topdown/manifest.json, inlined by `define` in vite.config.ts */
  const __TOPDOWN_MANIFEST__: TopdownManifest
}

export {}
