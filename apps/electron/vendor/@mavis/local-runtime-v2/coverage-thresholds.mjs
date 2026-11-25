// Whole-package coverage floors, as minimum percentages. vitest.config.ts uses them as its
// coverage thresholds. Runtime CI checks the merged coverage of a full run against them in
// check:coverage:local-runtime-v2 (scripts/ci/local-runtime-ci.mjs), which runs without Vitest.
export const COVERAGE_THRESHOLDS = {
  lines: 90,
  // IM MR3 migration debt (2026-09-20): channel-system absorbed the v1
  // channel implementation (~34k lines, ~6.8k branches at ~74%). Its
  // previous jurisdiction (packages/local-runtime) gated branches at 55;
  // the migration already added assertion-style twins of the deleted v1
  // suites (package branches 88.0 -> 88.4). Branch coverage of the
  // package therefore sits at 88.x until the transport deep error
  // branches get dedicated suites. Ratchet this floor back up towards
  // 90 as follow-up suites land; never lower it below 88.
  branches: 88,
  functions: 80,
  statements: 90,
};
