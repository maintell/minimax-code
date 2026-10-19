/**
 * Per-platform inbound transport restore passes.
 *
 * Migration copy (MR2): v1 `api/host-channel-restore-platforms.ts` with
 * imports remapped to v2 transport modules and each per-record loop body
 * extracted into a `visit*Record` helper (v2 lint complexity budget). The
 * heavy per-record logging is deliberate and preserved verbatim: every record
 * visit produces exactly one skip/attempt line so a missing transport can be
 * diagnosed by grep alone.
 */
import { feishuClientId } from '../transport/feishu/feishu-store.js';
import { telegramClientId, } from '../transport/telegram/telegram-store.js';
import { wechatClientId } from '../transport/wechat/wechat-store.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Read one platform store without throwing, so the caller can inspect all
 * three platforms up front (family gate) while a broken store still fails only
 * its own platform — see {@link requirePlatformRecords}.
 */
export async function loadPlatformRecords(list) {
    try {
        return { records: await list() };
    }
    catch (error) {
        return { error };
    }
}
/** Re-throw a deferred store load error inside the owning platform's try. */
function requirePlatformRecords(loaded) {
    if (!loaded.records)
        throw loaded.error;
    return loaded.records;
}
/**
 * Feishu: websocket mode is agent-scoped. Start one WS client per bound agent
 * instead of sharing the default adapter's app credentials. We log at every
 * fork so "why didn't WS come up for agent X" can be answered by grepping
 * alone — no "absence of log" reasoning required.
 */
export async function restoreFeishuBindings(input) {
    logger.info({ platform: 'feishu' }, 'Feishu WS restore start');
    try {
        const records = requirePlatformRecords(input.loaded);
        logger.info({
            platform: 'feishu',
            recordCount: records.length,
            agents: records.map((r) => r.agentName),
        }, 'Feishu WS restore store loaded');
        // Distinguish "store genuinely empty" from "store load failed" — both
        // surface as `records: 0` in the summary below, but the latter should
        // also produce a louder error log inside the store itself. Logging
        // here makes the empty-store case at least grep-able when a desktop
        // restart leaves WS un-started.
        if (records.length === 0) {
            logger.info({ platform: 'feishu' }, 'Feishu WS restore: no bindings found in store (file empty or all records failed to parse)');
        }
        // Collect the per-agent WS start promises instead of `void`-ing them —
        // the old fire-and-forget silently swallowed rejections, so a desktop
        // reboot with a broken Feishu connection produced zero log lines while
        // the status API still echoed the persisted `connected: true`.
        const attempts = [];
        let skipped = 0;
        for (const record of records) {
            if (visitFeishuRecord(record, input) === 'skipped') {
                skipped += 1;
                continue;
            }
            logger.info({ agentName: record.agentName, platform: 'feishu' }, 'Feishu WS restore per-agent attempt scheduled');
            attempts.push({
                agentName: record.agentName,
                promise: input.startFeishuWs(record.agentName),
            });
        }
        const summary = await settleFeishuAttempts(attempts);
        logger.info({
            records: records.length,
            wsAttempted: attempts.length,
            wsSucceeded: summary.wsSucceeded,
            wsFailed: summary.wsFailed,
            skipped,
            platform: 'feishu',
        }, 'Feishu WS restore summary');
        if (summary.failure)
            throw summary.failure;
    }
    catch (err) {
        logger.error({ err, platform: 'feishu' }, 'Channel inbound loop restore failed');
        throw err;
    }
}
/**
 * One Feishu record's registration + skip gates. Registration side effects
 * (exact client + adapter) intentionally run BEFORE the quarantine/mode
 * gates, mirroring v1: outbound routing must work even when inbound stays
 * dark. Returns `'attempt'` only when a WS start should be scheduled.
 */
function visitFeishuRecord(record, input) {
    // Per-agent visitation trace: every record produces exactly one of
    // {skipped:*, attempt}. Grepping by `agentName` gives the full decision
    // path for that agent without cross-referencing summary counts against
    // the raw store dump.
    logger.info({
        platform: 'feishu',
        agentName: record.agentName,
        clientId: record.clientId,
        mode: record.mode,
        connected: record.connected,
        enabled: record.enabled,
        hasAppId: Boolean(record.appId),
        hasAppSecret: Boolean(record.appSecret),
    }, 'Feishu WS restore per-agent visit');
    if (!record.enabled) {
        input.policy.unregisterDisabled('feishu', feishuClientId(record.agentName));
        logger.info({ agentName: record.agentName, platform: 'feishu' }, 'Feishu WS restore skipped: record disabled (client + adapter not registered)');
        return 'skipped';
    }
    input.registerFeishuClient(record);
    // Ensure the per-agent adapter exists + is registered even when WS is
    // disabled — it is also the webhook inbound handler, so multi-instance
    // routing must not depend on the websocket transport being on.
    input.getOrCreateFeishuAdapter(record.agentName);
    if (!input.policy.startInboundLoops) {
        logger.info({ agentName: record.agentName, platform: 'feishu' }, 'Feishu WS restore skipped: startup execution quarantined');
        return 'skipped';
    }
    if (record.mode !== 'websocket') {
        logger.info({ agentName: record.agentName, mode: record.mode, platform: 'feishu' }, 'Feishu WS restore skipped: mode not websocket');
        return 'skipped';
    }
    if (!record.connected) {
        logger.info({
            agentName: record.agentName,
            connected: record.connected,
            enabled: record.enabled,
            platform: 'feishu',
        }, 'Feishu WS restore skipped: not connected/enabled');
        return 'skipped';
    }
    if (!record.appId || !record.appSecret) {
        logger.info({ agentName: record.agentName, platform: 'feishu' }, 'Feishu WS restore skipped: missing credentials');
        return 'skipped';
    }
    return 'attempt';
}
/** Await every scheduled WS start and fold the per-agent outcomes. */
async function settleFeishuAttempts(attempts) {
    const settled = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
    let wsSucceeded = 0;
    let wsFailed = 0;
    let failure;
    settled.forEach((result, index) => {
        // Parallel arrays by construction: `settled[i]` settles `attempts[i]`.
        const agentName = attempts[index]?.agentName ?? 'unknown';
        if (result.status === 'rejected') {
            wsFailed += 1;
            failure ??= result.reason;
            logger.error({ err: result.reason, agentName, platform: 'feishu' }, 'Feishu WS restore failed');
            return;
        }
        // `startFeishuWs` resolves `true` when the transport actually started;
        // `false` / `undefined` mean "did not start" (disabled / precondition
        // miss / error already logged by the host wrapper) — count as failed
        // so the summary reflects the real transport state.
        if (result.value === true) {
            wsSucceeded += 1;
            logger.info({ agentName, platform: 'feishu' }, 'Feishu WS restore per-agent succeeded');
        }
        else {
            wsFailed += 1;
            failure ??= new Error(`CHANNEL_RESTORE_FAILED: feishu:${agentName}`);
            logger.warn({ agentName, platform: 'feishu', started: result.value ?? null }, 'Feishu WS restore per-agent did not start (see prior start-skipped/failed log for cause)');
        }
    });
    return { wsSucceeded, wsFailed, failure };
}
/**
 * WeChat: enumerate every bound agent and start one monitor wire per
 * `wechat:<agentName>` client. Account binding is agent-scoped; sharing one
 * adapter/monitor would make secondary agents look bound but never receive.
 * Same log discipline as {@link restoreFeishuBindings}.
 */
export async function restoreWeChatBindings(input) {
    logger.info({ platform: 'wechat' }, 'WeChat monitor restore start');
    try {
        const records = requirePlatformRecords(input.loaded);
        logger.info({
            platform: 'wechat',
            recordCount: records.length,
            agents: records.map((r) => r.agentName),
        }, 'WeChat monitor restore store loaded');
        if (records.length === 0) {
            logger.info({ platform: 'wechat' }, 'WeChat monitor restore: no bindings found in store');
        }
        let attempted = 0;
        let skipped = 0;
        let failure;
        for (const record of records) {
            const outcome = await visitWeChatRecord(record, input);
            if (outcome.kind === 'skipped') {
                skipped += 1;
                continue;
            }
            attempted += 1;
            failure ??= outcome.failure;
        }
        logger.info({
            platform: 'wechat',
            records: records.length,
            attempted,
            skipped,
        }, 'WeChat monitor restore summary');
        if (failure)
            throw failure;
    }
    catch (err) {
        logger.error({ err, platform: 'wechat' }, 'Channel inbound loop restore failed');
        throw err;
    }
}
/** One WeChat record's gates + monitor start; mirrors v1 order exactly. */
async function visitWeChatRecord(record, input) {
    logger.info({
        platform: 'wechat',
        agentName: record.agentName,
        clientId: record.clientId,
        mode: record.mode,
        connected: record.connected,
        enabled: record.enabled,
        hasBotToken: Boolean(record.botToken),
        botTokenPending: Boolean(record.botToken?.startsWith('pending:')),
    }, 'WeChat monitor restore per-agent visit');
    if (!record.enabled) {
        input.policy.unregisterDisabled('wechat', wechatClientId(record.agentName));
        logger.info({ agentName: record.agentName, platform: 'wechat' }, 'WeChat monitor restore skipped: record disabled (client + adapter not registered)');
        return { kind: 'skipped' };
    }
    // Creating the adapter also registers its outbound client, so it must
    // stay behind the enabled gate above.
    const adapter = input.getOrCreateWeChatAdapter(record.agentName);
    if (!input.policy.startInboundLoops) {
        logger.info({ agentName: record.agentName, platform: 'wechat' }, 'WeChat monitor restore skipped: startup execution quarantined');
        return { kind: 'skipped' };
    }
    if (record.mode !== 'polling') {
        logger.info({ agentName: record.agentName, mode: record.mode, platform: 'wechat' }, 'WeChat monitor restore skipped: mode not polling');
        return { kind: 'skipped' };
    }
    if (!record.connected) {
        logger.info({
            agentName: record.agentName,
            connected: record.connected,
            enabled: record.enabled,
            platform: 'wechat',
        }, 'WeChat monitor restore skipped: not connected/enabled');
        return { kind: 'skipped' };
    }
    if (!record.botToken || record.botToken.startsWith('pending:')) {
        logger.info({ agentName: record.agentName, platform: 'wechat' }, 'WeChat monitor restore skipped: missing/pending bot token');
        return { kind: 'skipped' };
    }
    logger.info({ agentName: record.agentName, platform: 'wechat' }, 'WeChat monitor restore per-agent attempt scheduled');
    try {
        if (!(await adapter.startMonitor())) {
            throw new Error(`CHANNEL_RESTORE_FAILED: wechat:${record.agentName}`);
        }
        return { kind: 'attempted' };
    }
    catch (err) {
        logger.error({ err, agentName: record.agentName, platform: 'wechat' }, 'WeChat monitor restore failed');
        return { kind: 'attempted', failure: err };
    }
}
/**
 * Telegram: read the bound bot token directly from the store and hand it to
 * `startPoller`. The adapter does its own "no dispatchInbound -> skip" guard so
 * this is safe to call when the adapter is wired without an inbound dispatcher
 * (CLI / tests). Same log discipline as feishu / wechat.
 */
export async function restoreTelegramBindings(input) {
    logger.info({ platform: 'telegram' }, 'Telegram poller restore start');
    try {
        const records = requirePlatformRecords(input.loaded);
        logger.info({
            platform: 'telegram',
            recordCount: records.length,
            agents: records.map((r) => r.agentName),
        }, 'Telegram poller restore store loaded');
        if (records.length === 0) {
            logger.info({ platform: 'telegram' }, 'Telegram poller restore: no bindings found in store');
        }
        let attempted = 0;
        let skipped = 0;
        let failure;
        for (const record of records) {
            const outcome = await visitTelegramRecord(record, input);
            if (outcome.kind === 'skipped') {
                skipped += 1;
                continue;
            }
            attempted += 1;
            failure ??= outcome.failure;
        }
        logger.info({
            platform: 'telegram',
            records: records.length,
            attempted,
            skipped,
        }, 'Telegram poller restore summary');
        if (failure)
            throw failure;
    }
    catch (err) {
        logger.error({ err, platform: 'telegram' }, 'Channel inbound loop restore failed');
        throw err;
    }
}
/** One Telegram record's gates + poller start; mirrors v1 order exactly. */
async function visitTelegramRecord(record, input) {
    logger.info({
        platform: 'telegram',
        agentName: record.agentName,
        clientId: record.clientId,
        mode: record.mode,
        enabled: record.enabled,
        hasBotToken: Boolean(record.botToken),
        botTokenPending: Boolean(record.botToken?.startsWith('pending:')),
    }, 'Telegram poller restore per-agent visit');
    if (!record.enabled) {
        input.policy.unregisterDisabled('telegram', telegramClientId(record.agentName));
        logger.info({ agentName: record.agentName, platform: 'telegram' }, 'Telegram poller restore skipped: record disabled (client + adapter not registered)');
        return { kind: 'skipped' };
    }
    input.registerTelegramClient(record);
    if (!input.policy.startInboundLoops) {
        logger.info({ agentName: record.agentName, platform: 'telegram' }, 'Telegram poller restore skipped: startup execution quarantined');
        return { kind: 'skipped' };
    }
    if (record.mode !== 'sdk') {
        logger.info({ agentName: record.agentName, mode: record.mode, platform: 'telegram' }, 'Telegram poller restore skipped: mode not sdk');
        return { kind: 'skipped' };
    }
    if (!record.botToken || record.botToken.startsWith('pending:')) {
        logger.info({ agentName: record.agentName, platform: 'telegram' }, 'Telegram poller restore skipped: missing/pending bot token');
        return { kind: 'skipped' };
    }
    logger.info({ agentName: record.agentName, platform: 'telegram' }, 'Telegram poller restore per-agent attempt scheduled');
    try {
        if (!(await input.getOrCreateTelegramAdapter(record.agentName).startPoller(record.botToken))) {
            throw new Error(`CHANNEL_RESTORE_FAILED: telegram:${record.agentName}`);
        }
        return { kind: 'attempted' };
    }
    catch (err) {
        logger.error({ err, agentName: record.agentName, platform: 'telegram' }, 'Telegram poller restore failed');
        return { kind: 'attempted', failure: err };
    }
}
//# sourceMappingURL=restore-platforms.js.map