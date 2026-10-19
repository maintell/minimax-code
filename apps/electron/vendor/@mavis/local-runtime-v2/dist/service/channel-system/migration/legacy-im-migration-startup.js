/**
 * Migration copy (MR1) of v1 `channels/legacy-im-migration-startup.ts`.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { NOOP_OBSERVABILITY_LOGGER } from '@mavis/shared/local-runtime-diagnostics/event-sink';
import { LocalFeishuChannelStore } from '../transport/feishu/feishu-store.js';
import { LocalTelegramChannelStore } from '../transport/telegram/telegram-store.js';
import { LocalWeChatChannelStore } from '../transport/wechat/wechat-store.js';
import { LocalChannelRouteStore } from '../routing/route-rules.js';
import { migrateLegacyImCredentialsIfNeeded } from './legacy-im-migration.js';
/**
 * Narrow V1 executor for importing legacy credential files into channel state.
 * Receipt and retry policy belong to the V2 Channel owner.
 */
export async function migrateLegacyImCredentialsOnStartup(input) {
    const dataDir = input.dataDir();
    const routeStore = await LocalChannelRouteStore.load(dataDir, input.agentName, input.nowMs);
    const summary = await migrateLegacyImCredentialsIfNeeded({
        dataDir,
        defaultAgentName: input.agentName,
        nowMs: input.nowMs,
        feishuStore: input.feishuStore,
        telegramStore: input.telegramStore,
        wechatStore: input.wechatStore,
        routeStore,
        bindingStore: input.bindingStore,
        sessionExists: async (id) => Boolean(await input.getSessionById(id)),
        observability: NOOP_OBSERVABILITY_LOGGER,
    });
    logger.info({ summary }, 'legacy IM credential migration completed');
}
//# sourceMappingURL=legacy-im-migration-startup.js.map