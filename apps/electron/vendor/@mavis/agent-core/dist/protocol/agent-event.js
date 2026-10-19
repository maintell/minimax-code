/**
 * `AgentEvent` — the in-process event stream emitted by an agent runtime
 * (e.g. `pi-agent-core`'s `Agent`) as it advances through an LLM turn.
 *
 * **Pure types only** — no implementations. This file exists so daemon and
 * cloud-runtime can share a single event vocabulary without depending on
 * `@earendil-works/pi-agent-core` directly. The shape mirrors pi-agent-core's
 * `AgentEvent` so structural compatibility holds: an `EventBridge` wired to
 * pi-agent-core can up-cast its events into this type without remapping.
 *
 * Lifecycle of a turn:
 * ```
 * agent_start
 *   ↓
 *   turn_start
 *     ↓
 *     message_start (assistant message handle opened)
 *     message_update (delta — text/thinking/tool_call additions)
 *     message_end (message body finalised)
 *     ↓
 *     tool_execution_start (tool dispatched)
 *     tool_execution_update (partial result / progress)
 *     tool_execution_end (tool resolved)
 *   ↓
 *   turn_end (this LLM turn concluded; another turn may follow)
 *   ↓
 * agent_end (the entire run is finished — emits the final message log)
 * ```
 *
 * Daemon usage hint
 * -----------------
 * Daemon's bridge converts `AgentEvent` into `AgentMessageChunk` /
 * `AgentMessage` for SSE delivery to local UI clients. `tool_execution_*`
 * events become `AgentMessageChunk.tool_calls[].tool_call_status` updates.
 *
 * Cloud impl hint
 * ---------------
 * Cloud-runtime's `EventBridge` converts `AgentEvent` into the canonical
 * `RuntimeEvent` (`stream.resp` / `session.status`), then `ExchangeSink`
 * adapts to `AgentMessageChunk` for Phase 1 and pushes `RuntimeEvent`
 * directly in Phase 2.
 */
export {};
//# sourceMappingURL=agent-event.js.map