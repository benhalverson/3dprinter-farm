import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/database/**/*.spec.ts'],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 15_000,
    fileParallelism: false,
  },
});
