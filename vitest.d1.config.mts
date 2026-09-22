import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/shopping/d1.spec.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
