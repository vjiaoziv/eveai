import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
