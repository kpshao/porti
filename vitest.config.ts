import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/engine/**/*.test.ts', 'src/importer/**/*.test.ts', 'src/main/**/*.test.ts'],
    environment: 'node'
  }
})
