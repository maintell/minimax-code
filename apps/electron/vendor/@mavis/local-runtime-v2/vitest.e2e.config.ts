import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// 历史验收入口仅供显式调用；不纳入默认单测与 MR CI。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/integration/**/*.e2e.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
