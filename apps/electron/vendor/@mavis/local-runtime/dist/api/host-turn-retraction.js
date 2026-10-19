/**
 * 发出整轮内容撤回的客户端侧动作（输出复审耗尽 或 异步输入复审拒绝）。从
 * `api/host.ts` 抽出，让撤回逻辑集中在一个可测试的小单元，同时把 host 文件
 * 保持在源码行数上限内。
 *
 * 顺序是关键，与原来 inline 的完全一致：
 *   1. `retractTurn` 丢掉 query bubble + 恢复 pre-turn pi history，配一个内存态
 *      fallback：裁剪 `messages` 并重置 `piHistory`。
 *   2. `content.retry.exceeded` 在 `message.rewind` 之前发，让客户端在 pending
 *      bubble 还完整时（经 `lastUserMsgId` 查找）恢复用户的文本/附件，随后 rewind
 *      的 re-fetch 才丢掉这一轮。
 *   3. `message.rewind` 触发异步 transcript re-fetch。
 *   4. 一条无内容的 `finished` session_status 走 send stream，让客户端标记终态
 *      完成、压掉 no-response UI。
 *
 * `variant` 选 composer banner 文案：输入复审因本地网络错误 fail-closed（未拿到
 * 裁定）时为 `network`，否则 `content`。
 */
export async function emitLocalTurnRetraction(deps) {
    const removedDisplayMsgIds = deps.userMessageIds ?? [];
    try {
        await deps.sessionWriter.retractTurn(deps.sessionId, deps.turnId, removedDisplayMsgIds, deps.preTurnPiHistory, async () => {
            const removed = new Set(removedDisplayMsgIds);
            const remaining = (deps.messages.get(deps.sessionId) ?? []).filter((message) => !(typeof message.msg_id === 'string' && removed.has(message.msg_id)));
            deps.messages.set(deps.sessionId, remaining);
            deps.piHistory.set(deps.sessionId, [...deps.preTurnPiHistory]);
        });
    }
    catch (err) {
        deps.metrics?.incr('session_turn_retract_total', { status: 'error' });
        throw err;
    }
    deps.metrics?.incr('session_turn_retract_total', { status: 'ok' });
    // refill 在 rewind 之前发，让 UI 从 pending bubble 恢复文本/附件。
    const hasUserQueryBubble = removedDisplayMsgIds.length > 0;
    deps.publishGlobalEvent({
        type: 'content.retry.exceeded',
        payload: {
            sessionId: deps.sessionId,
            // 输入框上方提示条该显哪套文案。`network`：输入复审因 local_error fail-closed
            // （未拿到裁定）；`content`：真·内容政策拦截（网关 reject 或输出复审耗尽）。
            // wire 上缺 variant → 客端默认内容提示。
            variant: deps.variant,
            ...(hasUserQueryBubble
                ? {
                    // UI 用这个 pending user-message id 恢复文本 + 附件。
                    lastUserMsgId: removedDisplayMsgIds[removedDisplayMsgIds.length - 1],
                }
                : {}),
        },
    });
    deps.publishGlobalEvent({
        type: 'message.rewind',
        payload: { sessionId: deps.sessionId, contextReset: true },
    });
    // 撤回无内容；发一条 in-band 终态压掉 no-response UI。
    deps.writer.writeJson({ type: 'session_status', session_status: { type: 'finished' } });
}
//# sourceMappingURL=host-turn-retraction.js.map