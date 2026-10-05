import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/persistence/*.spec.ts'],
    environment: 'node',
  },
});
