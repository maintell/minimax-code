/**
 * `contextManagerExtension` —— 把 `ContextManager` 装进 `@mavis/agent-runtime`
 * 的 extension SPI，让 host 通过 `createAgentRuntime({ base: [contextManagerExtension(mgr)] })`
 * 挂载而不是自己去 `hooks.beforeLlmCallHook = [manager.beforeLlmCall]`。
 *
 * 设计文档 §4.3 表把 context-manager 定为首个迁移 extension，SPI 侧走
 * `pi.on('before_llm_call')` 装 `manager.beforeLlmCall`（其内部返回
 * `PiBeforeLlmCallHookDecision`——`replaceMessages` 直接对应 compaction
 * 替换，`continue`/`skip` 对应无需压缩）。
 *
 * Extension 是无状态 factory：host 自己构造好 `ContextManager` 实例后传进来。
 * Extension 内部不做 IO、不构造 lock、不读 settings——保持 §4.4 常见问题 Q6
 * "extension 内部状态由作者用 `Map<sessionId, ...>` 隔离" 的边界。
 */
/**
 * Build the extension. The factory closes over `manager` so downstream code
 * can call `pi.on(...)` with a stable handler reference in `init`.
 */
export function contextManagerExtension(options) {
    const { manager, observer } = options;
    const id = options.id ?? 'context-manager';
    const description = options.description ??
        'Compact conversation history before each LLM call to keep the context window under threshold.';
    return {
        id,
        description,
        init(pi) {
            // `manager.beforeLlmCall` is bound to the manager instance and satisfies
            // the pi-native `PiBeforeLlmCallHook` shape (input) => decision. The SPI
            // adapter re-signs it to (event, ctx) — we drop ctx here since the
            // manager only needs the pi payload it already accepts. Arity is 1 so a
            // future `(...a) => manager.beforeLlmCall(...a)` regression would show up
            // in `context-manager.test.ts` (see arity assertion there).
            pi.on('before_llm_call', async (input) => {
                let decision;
                try {
                    decision = await manager.beforeLlmCall(input);
                }
                catch (err) {
                    if (observer?.onError) {
                        try {
                            await observer.onError(err, input);
                        }
                        catch {
                            // Observer errors must not shadow the original manager error —
                            // swallow so pi loop still sees the manager failure.
                        }
                    }
                    throw err;
                }
                if (observer?.onDecision && decision !== undefined) {
                    try {
                        await observer.onDecision(decision, input);
                    }
                    catch {
                        // Decision observers are optional bus / metrics side effects. A
                        // reporting failure must not replace a successful manager result.
                    }
                }
                return decision;
            });
            if (observer?.onHistoryChanged) {
                const handler = observer.onHistoryChanged;
                const errorSink = observer.onHistoryChangedError;
                pi.on('on_history_changed', async (input) => {
                    try {
                        await handler(input);
                    }
                    catch (err) {
                        if (errorSink) {
                            try {
                                await errorSink(err, input);
                            }
                            catch {
                                // Reporter failure must not shadow the original persistence error.
                            }
                        }
                        // Preserve the original error so PiTurnRunner can apply its
                        // reason-specific policy: messageDelta warns/continues, while
                        // replaceMessages is fail-closed.
                        throw err;
                    }
                });
            }
        },
    };
}
//# sourceMappingURL=context-manager.js.map