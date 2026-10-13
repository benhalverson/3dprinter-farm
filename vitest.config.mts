import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@cf-wasm/photon/workerd': '@cf-wasm/photon/node' } },
  test: {
    coverage: { provider: 'istanbul' },
    exclude: [
      ...configDefaults.exclude,
      'test/project-notes/**',
      'test/persistence/**',
      'test/database/**',
    ],
    isolate: true,
    environment: 'node',
    setupFiles: ['./test/network.ts', './test/setup.ts'],
  },
});
