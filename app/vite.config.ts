import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fsApiPlugin } from './server/fsApi'

// Inlined at build time: fetch() over the tauri:// custom protocol is
// unreliable in the packaged WebKitGTK webview, so the manifest can't be
// fetched at runtime like the dev server serves it.
const topdownManifest = readFileSync(
  new URL('./public/topdown/manifest.json', import.meta.url),
  'utf8',
)

export default defineConfig({
  plugins: [react(), fsApiPlugin()],
  define: { __TOPDOWN_MANIFEST__: topdownManifest },
  // `tauri dev` needs the fixed port and unswallowed Rust build errors
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
