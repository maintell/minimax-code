import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

const mode = process.env.MAVIS_RUNTIME_CI_MODE;
if (!['affected', 'full'].includes(mode ?? '')) {
  throw new Error('Runtime CI requires an explicit selection mode');
}
if (!process.env.MAVIS_RUNTIME_CI_REPORT_DIR)
  throw new Error('Runtime CI report directory is required');

const coverage = base.test?.coverage;
if (coverage?.provider !== 'v8')
  throw new Error('Runtime CI expects the base V8 coverage provider');

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    watch: false,
    coverage: {
      ...coverage,
      all: mode === 'full',
      // A shard cannot meet the whole-package floor by itself. check:coverage:local-runtime-v2
      // merges the verified shards' reports and checks a full run against the floor.
      thresholds: {},
      reporter: ['json', 'text-summary'],
      reportsDirectory: process.env.MAVIS_RUNTIME_CI_REPORT_DIR,
    },
  },
});
