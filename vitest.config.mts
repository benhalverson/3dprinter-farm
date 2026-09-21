import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/project-notes/**'],
    isolate: true,
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        miniflare: {
          // This test-only runtime does not load Wrangler's default SQL text rule.
          modulesRules: [{ type: 'Text', include: ['**/*.sql'] }],
          compatibilityDate: '2024-10-05',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
