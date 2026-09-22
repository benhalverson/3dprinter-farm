import { defineConfig } from 'vitest/config';

// Deliberately omit test/setup.ts: only email delivery is mocked here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.spec.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
