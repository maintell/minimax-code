/** 同一 Turn 的重复启动通知按 turnId 去重的容量上限。 */
const MAX_SEEN_TURNS = 512;
/**
 * §5.10 的唤醒观察者：消费 Turn 启动事实，核对根会话身份、按 turnId 去重后发出
 * `task-start`。恢复执行、崩溃重放与 steer 不构成触发事件（§2.3），由 Turn 所有者
 * 在上游保证；子任务由这里的根身份核对排除，重复 turnId 做兜底去重。
 */
export class MemoryTurnObserverAdapter {
    reconciler;
    source;
    diagnostics;
    seenTurns = new Set();
    constructor(reconciler, source, diagnostics) {
        this.reconciler = reconciler;
        this.source = source;
        this.diagnostics = diagnostics;
    }
    async observeTurnStart(input) {
        if (!input.isOrdinaryInputTurn) {
            this.skipped('non-ordinary-input', input);
            return;
        }
        const key = `${input.sessionId}\0${input.turnId}`;
        if (this.seenTurns.has(key)) {
            this.skipped('duplicate-turn', input);
            return;
        }
        this.seenTurns.add(key);
        this.trimSeenTurns();
        // §5.10 根会话身份核对：turn_start 对所有 Turn 发出，子任务在这里排除。
        // 身份读取失败按非根处理——唤醒丢失由下一轮根 Turn 补上，不冒泡。
        if (this.source) {
            try {
                const ctx = await this.source.readContext(input.sessionId);
                if (ctx.status !== 'found' || !ctx.rootConversation) {
                    this.skipped('non-root-or-missing-session', input);
                    return;
                }
            }
            catch (error) {
                this.diagnostics?.event('turn.source-failed', { input, error });
                return;
            }
        }
        const signal = {
            kind: 'task-start',
            triggerSessionId: input.sessionId,
            turnId: input.turnId,
            createdBeforeMs: input.startedAtMs,
        };
        try {
            this.reconciler.kick(signal);
        }
        catch (error) {
            this.diagnostics?.event('turn.wake-failed', { signal, error });
        }
    }
    skipped(reason, input) {
        this.diagnostics?.event('turn.skipped', { reason, input });
    }
    trimSeenTurns() {
        while (this.seenTurns.size > MAX_SEEN_TURNS) {
            const oldest = this.seenTurns.values().next().value;
            if (oldest === undefined)
                return;
            this.seenTurns.delete(oldest);
        }
    }
}
//# sourceMappingURL=turn-observer.js.map