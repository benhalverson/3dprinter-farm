import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ['NOTIFICATIONS_TEST_DB'],
        bindings: {
          // Exercise the order schema and new migration unchanged. The inherited
          // full history duplicates cart user_id/filament_id in 0002/0003/0004.
          NOTIFICATIONS_TEST_MIGRATIONS: (
            await readD1Migrations('./drizzle/migrations')
          ).filter(migration =>
            /^(0000_|0001_|0005_|0007_|0009_|0018_)/.test(migration.name),
          ),
        },
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
    exclude: [...configDefaults.exclude, 'test/project-notes/**'],
    isolate: true,
    setupFiles: ['./test/setup.ts'],
  },
});
