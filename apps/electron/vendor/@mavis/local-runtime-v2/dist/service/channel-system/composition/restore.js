import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { assertSingleEnabledRecordPerFamily, } from '../binding/family-gate.js';
import { loadPlatformRecords, restoreFeishuBindings, restoreTelegramBindings, restoreWeChatBindings, } from './restore-platforms.js';
/**
 * Restore persisted channel bindings for every already-bound agent. Exact
 * outbound clients and adapters are registered for enabled records only;
 * callers may quarantine transport startup so a copied binding does not resume
 * WS, monitor, or poller activity.
 *
 * Two gates run BEFORE anything is registered or started (plan §5.6):
 *   - a canonical-family gate — two enabled records of one Agent family on one
 *     platform fail the whole restore with `PRIMARY_AGENT_CHANNEL_CONFLICT`
 *     and zero transports, instead of letting the last writer win;
 *   - a per-record `enabled` gate — a disabled record enters neither registry
 *     and starts no inbound; an already-registered loser is unregistered.
 *
 * Store reads and transport starts are strict: an enabled binding that cannot
 * restore rejects the caller's startup instead of reporting a ready runtime
 * with an inert channel. Access-control seeding below remains best-effort.
 */
export async function restoreInboundLoops(input) {
    // Load every platform before registration so the family gate can reject
    // duplicate enabled records without starting either transport.
    const [feishuRecords, telegramRecords, wechatRecords] = await Promise.all([
        loadPlatformRecords(() => input.feishuStore.list()),
        loadPlatformRecords(() => input.telegramStore.list()),
        loadPlatformRecords(() => input.wechatStore.list()),
    ]);
    for (const [platform, loaded] of [
        ['feishu', feishuRecords],
        ['telegram', telegramRecords],
        ['wechat', wechatRecords],
    ]) {
        if (!loaded.records)
            continue;
        await assertSingleEnabledRecordPerFamily({
            platform,
            records: loaded.records,
            ...(input.resolveAgentReadScope
                ? { resolveAgentReadScope: input.resolveAgentReadScope }
                : {}),
        });
    }
    const policy = {
        startInboundLoops: input.startInboundLoops !== false,
        unregisterDisabled: (platform, clientName) => {
            input.clientRegistry?.unregister(clientName);
            input.adapterRegistry?.unregister(platform, clientName);
        },
    };
    // Restore each platform concurrently, but wait for every transport to
    // settle before surfacing a failure so caller cleanup cannot race a still-
    // starting sibling transport.
    const settled = await Promise.allSettled([
        restoreFeishuBindings({
            loaded: feishuRecords,
            registerFeishuClient: input.registerFeishuClient,
            startFeishuWs: input.startFeishuWs,
            getOrCreateFeishuAdapter: input.getOrCreateFeishuAdapter,
            policy,
        }),
        restoreWeChatBindings({
            loaded: wechatRecords,
            getOrCreateWeChatAdapter: input.getOrCreateWeChatAdapter,
            policy,
        }),
        restoreTelegramBindings({
            loaded: telegramRecords,
            registerTelegramClient: input.registerTelegramClient,
            getOrCreateTelegramAdapter: input.getOrCreateTelegramAdapter,
            policy,
        }),
    ]);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
        throw failure.reason;
    // Migration doc §接入点 4: ensureDefaultPolicy must run for every
    // bound record after a desktop restart so the AC UI has a fresh
    // entry to render. Failures here degrade to "no entry written yet"
    // (the next inbound will fall through to the default policy until
    // the operator edits the YAML), which is the same behaviour as
    // before this MR — never block startup on AC seeding.
    const accessControlStore = input.accessControlStore;
    if (!accessControlStore)
        return;
    try {
        const seedAll = async (platform, clientIds) => {
            for (const clientName of clientIds) {
                await accessControlStore.ensureDefaultPolicy(platform, clientName);
            }
        };
        await Promise.all([
            seedAll('feishu', (feishuRecords.records ?? []).map((r) => r.clientId)),
            seedAll('telegram', (telegramRecords.records ?? []).map((r) => r.clientId)),
            seedAll('wechat', (wechatRecords.records ?? []).map((r) => r.clientId)),
        ]);
    }
    catch (err) {
        logger.warn({ err }, 'Channel access-control seeding failed');
    }
}
//# sourceMappingURL=restore.js.map