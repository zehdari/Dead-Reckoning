import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fsApiPlugin } from './server/fsApi'

export default defineConfig({
  plugins: [react(), fsApiPlugin()],
  // `tauri dev` needs the fixed port and unswallowed Rust build errors
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
