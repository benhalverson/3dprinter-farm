import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/project-notes/**'],
    isolate: true,
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        // Each persistence test uses unique object/visitor IDs. Vitest 3's storage
        // snapshotter predates the WAL metadata files used by current workerd.
        isolatedStorage: false,
        // Explicit local bindings prevent Workers AI from reaching remote resources.
        main: './test/shopping/worker.ts',
        miniflare: {
          compatibilityDate: '2024-10-05',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: {
            SHOPPING_AGENT: { className: 'ShoppingAgent', useSQLite: true },
            SHOPPING_LEDGER: { className: 'ShoppingLedger', useSQLite: true },
          },
          d1Databases: ['DB'],
          bindings: {
            AGENT_ENABLED: 'true',
            AGENT_PRICE_VERSION: 'glm-5.3-flash-2026-09-21',
            AGENT_NETWORK_SECRET: 'local-test-identity-secret-only-32-bytes',
            AI: {},
          },
        },
      },
    },
  },
});
