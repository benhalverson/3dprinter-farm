import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'test/project-notes/**',
      'test/shopping/d1.spec.ts',
    ],
    isolate: true,
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-10-05',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
