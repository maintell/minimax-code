import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { resolveWorkspaceSourceAliases } from '../../scripts/ci/workspace-source-aliases.mjs';
import unitConfig from './vitest.config.ts';

export default mergeConfig(
  unitConfig,
  defineConfig({
    resolve: {
      alias: resolveWorkspaceSourceAliases({
        root: fileURLToPath(new URL('../..', import.meta.url)),
        packageName: '@mavis/local-runtime',
      }),
    },
  }),
);
