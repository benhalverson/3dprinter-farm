import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2024-10-05',
        // Vitest 4 observes Node rejection events; wait for promise adoption
        // before classifying a rejection as unhandled (default since 2026-03-03).
        compatibilityFlags: [
          'nodejs_compat',
          'unhandled_rejection_after_microtask_checkpoint',
        ],
        // Preserve native Worker WASM loading for Photon image validation.
        modulesRules: [
          { type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true },
        ],
      },
    }),
  ],
  test: {
    coverage: { provider: 'istanbul' },
    exclude: [
      ...configDefaults.exclude,
      'test/project-notes/**',
      'test/database/**',
      'test/persistence/**',
    ],
    isolate: true,
    setupFiles: ['./test/setup.ts'],
  },
});
