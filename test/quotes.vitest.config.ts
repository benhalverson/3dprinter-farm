import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@cf-wasm/photon/workerd': '@cf-wasm/photon/node' } },
  test: {
    setupFiles: ['./test/network.ts'],
    include: ['test/persistence/*.spec.ts'],
    environment: 'node',
  },
});
