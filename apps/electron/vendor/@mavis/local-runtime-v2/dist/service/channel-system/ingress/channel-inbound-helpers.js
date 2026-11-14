/**
 * Inbound-hub helpers split from `channel-bridge-infra.ts` (file-size
 * budget). Migration copies (MR1) of the module-level helpers of v1
 * `channels/infra.ts`; `buildEnqueueChannelContext` is the extracted
 * channelContext literal of the v1 enqueue call.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Translate a non-`allow` `checkChannelAccess` decision into the runner's
 * inbound shape. We deliberately do NOT send a chat reply on `deny`:
 *   - Group hard-block: any reply would surface inside the group, which
 *     would leak the policy to non-owner members and invite probing.
 *   - Not-owner: replying to a non-owner DMs them with policy text, which
 *     spams them and reveals that another user owns the channel.
 *   - Dedup: the user has already received a response for this event; a
 *     second reply would be a duplicate.
 * The `accessDeniedReason` field is set so internal callers (e.g. the
 * `status` endpoint or a future operator dashboard) can surface why an
 * event was dropped, without exposing it to the IM platform.
 */
export function mapAccessDenial(access, lane) {
    if (access === 'dedup') {
        return { handled: true, deduplicated: true, lane };
    }
    // access === 'deny' — distinguish group-block vs not-owner for diagnostics.
    // We re-derive the reason on the hot path rather than threading a structured
    // deny reason through the access layer, because the access decision itself
    // is the only thing HTTP handlers need to react to.
    return {
        handled: true,
        lane,
        accessDeniedReason: 'not-owner-or-non-p2p',
    };
}
/**
 * Channel language convention (matches the archon-side `channelLanguage`
 * contract): Telegram replies in English, every other IM platform in Chinese.
 * Kept local to the infra so the `/compact` two-stage receipts don't pull in a
 * heavier i18n dependency for two strings.
 */
export function channelPrefersZh(platform) {
    return platform !== 'telegram';
}
/** Two-stage `/compact` "started" line — sent only when a compaction genuinely begins. */
function compactionStartReply(zh) {
    return zh ? '🔄 正在压缩上下文…' : '🔄 Compacting context…';
}
/**
 * Terminal `/compact` receipt for a given {@link CompactionOutcome} code. The
 * success line intentionally omits N→M counts (per spec §D). Unknown / hard
 * failure codes fall back to the generic "unsupported" copy so the sender is
 * never left without feedback.
 */
function compactionReply(code, zh) {
    switch (code) {
        case 'OK':
            return zh ? '✨ 上下文已压缩' : '✨ Context compacted.';
        case 'NOTHING_TO_COMPACT':
            return zh ? '📭 暂无可压缩的上下文' : '📭 Nothing to compact.';
        case 'SESSION_BUSY':
            return zh
                ? '⏳ 会话正在处理中，请稍后再试（可先 /stop）'
                : '⏳ Session is busy, try again later (or /stop).';
        case 'COMPACTION_UNSUPPORTED':
        default:
            return zh ? '⚠️ 当前会话不支持压缩' : '⚠️ This session does not support compaction.';
    }
}
/** Channel origin metadata attached to the enqueued message (v1 shape). */
export function buildEnqueueChannelContext(ctx, route) {
    return {
        platform: ctx.platform,
        chatType: ctx.chatType,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        clientName: ctx.clientName,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        ...(ctx.sourceMessageId ? { sourceMessageId: ctx.sourceMessageId } : {}),
        ...(ctx.contextToken ? { contextToken: ctx.contextToken } : {}),
        ...(route.targetAgentId ? { targetAgentId: route.targetAgentId } : {}),
    };
}
/**
 * Projects the host enqueue result onto the inbound result: a merged message
 * carries `steered` (no queue item), a queued one carries its queue fields
 * plus the reason it could not be sent immediately, when there is one.
 */
export function enqueueOutcomeFields(queued) {
    if (!queued)
        return {};
    if ('steered' in queued)
        return { steered: queued.steered };
    return {
        queueItemId: queued.itemId,
        ...(queued.ahead !== undefined ? { queueAhead: queued.ahead } : {}),
        ...(queued.position !== undefined ? { queuePosition: queued.position } : {}),
        ...(queued.queueReason ? { queueReason: queued.queueReason } : {}),
    };
}
/** Execute /compact after the ingress hub has authorized the current channel. */
export async function handleChannelCompactCommand(input) {
    const { ctx, command, lane, extras } = input;
    // ── `/compact` handler ──
    // Out-of-band compaction request for the active session. We do NOT
    // touch the routing table here — `/compact` runs on whichever session
    // the route resolver currently points at (typically a branch task
    // session for short-lived work, or the agent root for the main chat).
    //
    // Stages:
    //   1. resolve route (skip cleanly if blocked / unrouteable),
    //   2. defensive check: refuse to crash if host omitted
    //      `requestCompaction` (some test scaffolding + the legacy
    //      HTTP-only boot path),
    //   3. invoke the compaction core. The core itself may return
    //      `SESSION_BUSY` / `UNSUPPORTED` / `SUCCESS` etc. — we mirror
    //      the code through the localized reply copy.
    //
    // Note: `args` here are the user's `/compact <custom instructions>`
    // payload. Like the dispatcher we log `argsLength` not the contents.
    const baseFields = {
        scope: 'channel.slash',
        op: 'compact',
        command: 'compact',
        lane,
        platform: ctx.platform,
        clientName: ctx.clientName,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        argsLength: command.args.length,
    };
    const startedAt = Date.now();
    const route = await input.routeResolver.resolve(ctx);
    if (route.blocked || !route.sessionId) {
        logger.warn({
            ...baseFields,
            ...(route.agentName ? { agentName: route.agentName } : {}),
            outcome: 'no_route',
            durationMs: Date.now() - startedAt,
        }, 'Channel /compact skipped — route resolver returned blocked or no sessionId');
        return { handled: true, command: 'compact', reply: 'No active route.', route, lane };
    }
    const zh = channelPrefersZh(ctx.platform);
    // Defensive: host did not wire the compaction core. Never crash the inbound
    // path — surface the "unsupported" copy so the sender gets feedback.
    if (!input.requestCompaction) {
        logger.warn({
            ...baseFields,
            agentName: route.agentName,
            sessionId: route.sessionId,
            outcome: 'unsupported',
            durationMs: Date.now() - startedAt,
        }, 'Channel /compact ignored — host did not wire requestCompaction');
        return {
            handled: true,
            command: 'compact',
            reply: compactionReply('COMPACTION_UNSUPPORTED', zh),
            route,
            sessionId: route.sessionId,
            lane,
        };
    }
    const customInstructions = command.args.trim() || undefined;
    const outcome = await input.requestCompaction({
        sessionId: route.sessionId,
        agentName: route.agentName,
        ...(customInstructions ? { customInstructions } : {}),
        reason: 'im_request',
        // The two-stage "started" line only fires once the core has passed its
        // busy/lock guards and is genuinely about to compact. A busy session
        // returns SESSION_BUSY before this runs, so no "started" line is sent.
        onStarted: extras.onProgress
            ? async () => {
                await extras.onProgress?.(compactionStartReply(zh));
            }
            : undefined,
    });
    const isSuccess = outcome.code === 'SUCCESS';
    if (isSuccess) {
        logger.info({
            ...baseFields,
            agentName: route.agentName,
            sessionId: route.sessionId,
            outcome: 'ok',
            compactionCode: outcome.code,
            durationMs: Date.now() - startedAt,
        }, 'Channel /compact completed');
    }
    else {
        logger.warn({
            ...baseFields,
            agentName: route.agentName,
            sessionId: route.sessionId,
            outcome: 'failed',
            compactionCode: outcome.code,
            durationMs: Date.now() - startedAt,
        }, 'Channel /compact did not succeed — surfacing localized reply to sender');
    }
    return {
        handled: true,
        command: 'compact',
        reply: compactionReply(outcome.code, zh),
        route,
        sessionId: route.sessionId,
        lane,
    };
}
//# sourceMappingURL=channel-inbound-helpers.js.map