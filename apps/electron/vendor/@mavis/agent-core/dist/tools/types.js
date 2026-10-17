/**
 * Tool 体系核心契约。
 *
 * `ToolDefinition` —— 工具的公开 contract。schema 是 typebox 形态
 * (`TSchema`),既被 PiTurnRunner 透传给 pi 作为 `AgentTool.parameters`,
 * 也用 `Static<S>` 推导 `ToolImpl.execute(input)` 的入参强类型。
 * `prepareArguments` / `executionMode` 直接映射到 Pi 0.79.1 `AgentTool`
 * 对应字段。
 *
 * `ToolExecutionContext` —— 每轮 turn 由 host 构造、闭包到 pi `AgentTool`
 * wrapper 里的最小 ctx。host 可以扩出自己的 ctx 子类型(cloud-runtime 的
 * `CloudRuntimeContext` 加了 reporter / bizId / workspaceRoot 等),
 * 在 `ToolImpl<S, TCtx>` 上声明对应 TCtx 即可。**严禁** 用 `AsyncLocalStorage`
 * 把 per-turn 状态注进 tool —— wrapper closure 是唯一注入点。
 *
 * `ToolImpl<S, TCtx>` —— 工具的实现。`execute(ctx, input, signal?, onUpdate?)` 第一个
 * 参数是 per-turn ctx,host 在 `assembleAgentTools` 里把 ctx 闭包 baked-in;
 * 同一个 ToolDefinition 可以有多个 ToolImpl 实现(cloud / local / mock),
 * 都走相同的 execute 签名。
 *
 * `RuntimeTool<S, TCtx>` —— the `(def, impl)` pair consumed by
 * PiTurnRunner. New platform-owned tools should prefer declaring this
 * object directly with `defineRuntimeTool(...)`, keeping the LLM-facing
 * definition and runtime implementation co-located.
 *
 * `bindTool(def)` / `toRuntimeTool(instance)` remain available for decorated
 * class implementations, but new code should prefer `defineRuntimeTool(...)`.
 */
export {};
//# sourceMappingURL=types.js.map