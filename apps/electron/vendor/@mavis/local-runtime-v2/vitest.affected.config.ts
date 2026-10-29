import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import config from './vitest.config';

// Selection must follow changes in the shared hook implementation, not its dist output.
// Execution keeps vitest.config.ts so the runtime still tests built workspace dependencies.
export default mergeConfig(config, {
  resolve: {
    alias: {
      '@mavis/plugin-hooks': fileURLToPath(
        new URL('../agent-modules/plugin-hooks/src/index.ts', import.meta.url),
      ),
    },
  },
});
