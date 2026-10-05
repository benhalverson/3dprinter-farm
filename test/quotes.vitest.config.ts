import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/persistence/checkoutQuotes.spec.ts'],
    environment: 'node',
  },
});
