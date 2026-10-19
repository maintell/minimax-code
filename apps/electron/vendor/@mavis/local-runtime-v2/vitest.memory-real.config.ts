import { mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

export default mergeConfig(base, {
  test: {
    env: { MAVIS_MEMORY_REAL_MODEL: '1' },
    testTimeout: 720_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
