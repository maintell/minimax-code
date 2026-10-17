/**
 * `@mavis/agent-runtime` — pluggable extension SPI + per-turn assembler
 * on top of `@mavis/agent-core`.
 *
 * 设计对齐 `packages/agent-runtime` 飞书设计文档 v1.0（吸收 review 后）。
 * 关键约束：
 *   - Extension 之间不允许相互 import；顺序仅由 host 装配加载顺序决定。
 *   - `assembleTurn(ctx)` 只做装配，不越界造 `RunTurnInput`——host 拿结果自己拼。
 *   - Registry 只做 in-memory 状态；持久化（例如 `extensionOverrides`）由 host 负责。
 *
 * 事件名沿用文档 §4.2 的新命名（含 `on_step_end` 对齐 pi 当前的 step completion 语义）；
 * `AssemblyResult.hooks` 映射到 `agent-core` 的 `PiTurnHooks.onStepEndHook`（§11.6
 * Step A 引入的首选名）。agent-core 侧仍兼容读取 deprecated per-step slot
 * `onTurnEndHook`，但 agent-runtime 单一写入语义明确的新字段——见 `registry.ts`
 * 的 `HOOK_MAPPINGS`。
 */
// ─────────────────────────── Hook / event names ───────────────────────
export const HOOK_NAMES = [
    'turn_start',
    'turn_end',
    'on_history_changed',
    'before_llm_call',
    'on_llm_call_prepared',
    'after_llm_call',
    'before_tool_call',
    'after_tool_call',
    'on_step_end',
];
//# sourceMappingURL=types.js.map