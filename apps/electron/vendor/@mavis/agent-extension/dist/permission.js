/**
 * `permissionExtension` —— 把 permission `PermissionEngine` 装进
 * `@mavis/agent-runtime` 的 extension SPI 的 `pi.on('before_tool_call')`
 * short-circuit event（设计文档 §4.3）。
 *
 * 边界策略：`@mavis/permission` 是纯 decision engine，`checkPermission(toolName,
 * input, ctx) => PermissionDecision` 需要 host 提供 `ToolPermissionContext`
 * （含 rules / mode / sandbox 状态等 host-specific 数据）。因此本 factory 接收
 * host 传入的 `decide(toolName, input, toolCallCtx) => Promise<PermissionDecision>`
 * closure——extension 内部只做"pi ctx → 决策 args → 结果转换"的胶水，engine
 * 本身住哪里由 host 决定（local-runtime 用 `LocalPermissionFacade`，cloud-runtime
 * 用 `CloudPermissionFacade`——设计文档 §4.3 表明确表示 cloud 有独立
 * `cloud-permission` extension）。
 *
 * 决策映射（pi 层 `BeforeToolCallResult` 只有 `{ block?, reason? }` 两态）：
 *   - `allow` → 先将 `rewrittenInput` 写回 live `toolContext.args`，再 return
 *     `undefined`（放行）
 *   - `deny`  → `{ block: true, reason }`（reason 由 host 侧 `reason-format`
 *     生成，UI/日志侧读；若未提供 `formatReason` 用 raw JSON.stringify 做兜底）
 *   - `ask`   → default `{ block: true, reason }`——pi loop 无原生 ASK 概念，
 *     运行时按 block 处理。**若 host 提供 `onAsk` 且它返回一个 resolved
 *     `PermissionDecision`**（用户实际同意/拒绝了），extension 会以 resolved
 *     决策的映射结果为准（allow → undefined 放行，deny/ask → block）。这条 seam
 *     让 host 能够把 ask fan-out 做成阻塞 promise（UI prompt → user click →
 *     resolve），本轮工具调用可以按用户回复实际放行/拒绝。**若 host 不提供 `onAsk`
 *     或它返回 `void`**，pi loop 直接看到 block，LLM 会收到拒绝，UI 需通过独立
 *     event 流分派 ask（比如 HTTP `/permissions` route 返回 requestId、
 *     LLM 需要在后续 turn 里重试），这是当前 host（`LocalPermissionFacade`）的
 *     现状。
 *
 */
function defaultFormatReason(decision) {
    try {
        return JSON.stringify(decision.reason);
    }
    catch {
        return String(decision.reason);
    }
}
function applyRewrittenInput(toolContext, rewrittenInput) {
    if (!rewrittenInput)
        return;
    if (toolContext.args &&
        typeof toolContext.args === 'object' &&
        !Array.isArray(toolContext.args)) {
        const target = toolContext.args;
        if (target === rewrittenInput)
            return;
        for (const key of Object.keys(target))
            delete target[key];
        Object.assign(target, rewrittenInput);
        return;
    }
    toolContext.args = { ...rewrittenInput };
}
export function permissionExtension(options) {
    const { decide, formatReason = defaultFormatReason, onAsk, onAskError } = options;
    const id = options.id ?? 'permission';
    const description = options.description ??
        'Enforce tool-call permission decisions (allow / deny / ask) via PermissionEngine before pi executes each tool.';
    function mapDecision(decision, summary, toolContext, fallbackRewrittenInput) {
        if (decision.behavior === 'allow') {
            applyRewrittenInput(toolContext, decision.rewrittenInput ?? fallbackRewrittenInput);
            return undefined;
        }
        // deny / ask / any future variant → fail-closed block per AGENTS.md §5.
        // The default branch defends against `PermissionBehavior` growing new
        // variants without a matching mapDecision arm; today it's unreachable
        // (union is `'allow' | 'deny' | 'ask'`), which is exactly the invariant
        // this comment records.
        return { block: true, reason: formatReason(decision, summary) };
    }
    const handler = async (toolContext, signal) => {
        const summary = {
            toolName: toolContext.toolCall.name,
            input: (toolContext.args ?? {}),
        };
        const decision = await decide(summary);
        if (decision.behavior === 'ask' && onAsk) {
            let resolved;
            try {
                const askResult = await onAsk(decision, summary, signal);
                if (askResult && typeof askResult === 'object' && 'behavior' in askResult) {
                    resolved = askResult;
                }
            }
            catch (err) {
                if (onAskError) {
                    try {
                        await onAskError(err, summary, signal);
                    }
                    catch {
                        // Observer error must not shadow the block posture.
                    }
                }
            }
            const effective = resolved ?? decision;
            return mapDecision(effective, summary, toolContext, decision.rewrittenInput);
        }
        return mapDecision(decision, summary, toolContext);
    };
    return {
        id,
        description,
        init(pi) {
            pi.on('before_tool_call', handler);
        },
    };
}
//# sourceMappingURL=permission.js.map