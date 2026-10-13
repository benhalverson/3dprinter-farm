import { defineConfig, mergeConfig } from 'vitest/config';
import config from '../../vitest.config.mts';

/** Browser processes reach only the loopback proxy; existing provider/DB guards remain enabled. */
export default mergeConfig(config, defineConfig({
  test: {
    include: ['test/browser/*.browser.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}));
