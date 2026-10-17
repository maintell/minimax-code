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
export function compactionStartReply(zh) {
    return zh ? '🔄 正在压缩上下文…' : '🔄 Compacting context…';
}
/**
 * Terminal `/compact` receipt for a given {@link CompactionOutcome} code. The
 * success line intentionally omits N→M counts (per spec §D). Unknown / hard
 * failure codes fall back to the generic "unsupported" copy so the sender is
 * never left without feedback.
 */
export function compactionReply(code, zh) {
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
//# sourceMappingURL=channel-inbound-helpers.js.map