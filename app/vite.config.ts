import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fsApiPlugin } from './server/fsApi'

export default defineConfig({
  plugins: [react(), fsApiPlugin()],
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
