/**
 * Agent message protocol types.
 *
 * **Pure types only** — no implementations. Migrated from
 * `packages/daemon/src/common/agent-protocol.ts` so the same shapes can be
 * referenced by daemon (local) and cloud-runtime (remote) hosts without
 * either side importing the other.
 *
 * `AgentMessage` represents a complete assistant turn (a closed message), and
 * `AgentMessageChunk` represents a streaming delta. They were originally
 * defined as part of the SSE wire format used by daemon → UI; runtime layers
 * (cloud-runtime ExchangeSink) translate between this shape and the
 * higher-level {@link RuntimeEvent} family.
 *
 * Phase 2 plan: this file becomes a pure structural representation while the
 * canonical wire format unifies on `RuntimeEvent`. Until then,
 * `AgentMessageChunk` is what daemon SSE pushes and what archon_server
 * accepts (cloud-runtime adapts its `RuntimeEvent` stream into this shape
 * before reporting upstream).
 */
/**
 * Logical type tag for `RespData` envelope frames. Daemon SSE wraps each
 * frame in `{ type, agent_message?, agent_message_chunk? }` and the type
 * field tells the consumer which alternate is set.
 */
export const RespDataType = {
    /** Complete `AgentMessage` (closed turn). */
    AgentMessage: 2,
    /** Streaming `AgentMessageChunk` (delta). */
    AgentMessageChunk: 6,
    /** Liveness ping — no payload. */
    Heartbeat: 10,
};
/**
 * Tool-call lifecycle stages emitted alongside an assistant message.
 * `Preparing` / `Prepared` are the model-side argument-streaming phases
 * (arguments still being generated / generated but not yet dispatched);
 * `Start` is the host dispatching the tool for execution.
 */
export const ToolCallStatus = {
    Start: 1,
    Finished: 2,
    Failed: 3,
    Preparing: 4,
    Prepared: 5,
};
/** Speaker role on a message. */
export const Role = {
    User: 'user',
    Assistant: 'assistant',
};
/** Logical type of a single complete message — see UI message rendering. */
export const MsgType = {
    AgentContent: 1,
    AgentToolCall: 2,
    SystemEvent: 3,
};
//# sourceMappingURL=agent-message.js.map