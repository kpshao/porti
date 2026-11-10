import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/engine/**/*.test.ts',
      'src/importer/**/*.test.ts',
      'src/fetcher/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'src/shared/**/*.test.ts'
    ],
    environment: 'node'
  }
})
