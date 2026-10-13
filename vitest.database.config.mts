import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@cf-wasm/photon/workerd': '@cf-wasm/photon/node' } },
  test: {
    setupFiles: ['./test/network.ts'],
    include: ['test/database/**/*.spec.ts'],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 15_000,
    fileParallelism: false,
  },
});
