import { defineConfig } from 'vitest/config';
import affected from './vitest.affected.config.js';

// 保留原 channel CI 门禁的九组行为，只更新迁移后的测试 owner。
export default defineConfig({
  ...affected,
  test: {
    ...affected.test,
    name: 'local-runtime-v2:channel',
    include: [
      'test/unit/infra/legacy-db/agent-contract.test.ts',
      'test/integration/channel-host-port-http.integration.test.ts',
      'test/integration/local-agent-root-replacement.integration.test.ts',
      'test/unit/agent/runtime/subagent-telemetry.test.ts',
      'test/integration/permission-host-http.integration.test.ts',
      'test/integration/local-desktop-service.integration.test.ts',
      'src/http/host/interaction/host-questionnaire-delivery.test.ts',
      'src/service/cron/compatibility/message-format.test.ts',
      'test/unit/infra/legacy-db/agent-name-conflict-migration.test.ts',
    ],
  },
});
