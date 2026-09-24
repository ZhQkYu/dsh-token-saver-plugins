import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/token-saver/tests/**/*.test.ts', 'plugins/token-saver-ui/tests/**/*.test.ts'],
    environment: 'node',
  },
})
