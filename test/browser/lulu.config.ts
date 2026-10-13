import { defineConfig, mergeConfig } from 'vitest/config';
import config from '../../vitest.config.mjs';

export default mergeConfig(
  config,
  defineConfig({
    test: {
      include: ['test/browser/lulu.integration.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
