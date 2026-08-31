import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/engine/**/*.test.ts'],
    environment: 'node'
  }
})
