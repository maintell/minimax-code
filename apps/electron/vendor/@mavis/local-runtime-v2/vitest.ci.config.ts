import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

const mode = process.env.MAVIS_RUNTIME_CI_MODE;
const phase = process.env.MAVIS_RUNTIME_CI_PHASE;
if (!['affected', 'full'].includes(mode ?? '') || !['shard', 'merge'].includes(phase ?? '')) {
  throw new Error('Runtime CI requires an explicit selection mode and reporting phase');
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
      // A shard cannot meet the whole-package floor by itself. Enforce the unchanged
      // thresholds only after every shard's test inventory and reports are verified.
      thresholds: mode === 'full' && phase === 'merge' ? coverage.thresholds : {},
      reporter: ['json', 'text-summary'],
      reportsDirectory: process.env.MAVIS_RUNTIME_CI_REPORT_DIR,
    },
  },
});
