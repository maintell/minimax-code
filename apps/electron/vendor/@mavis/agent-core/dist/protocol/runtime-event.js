/**
 * Runtime event surface — bridges `@mavis/protocol`'s thrift-generated
 * shapes into the names agent-core internals use.
 *
 * The protocol package was regenerated from a thrift IDL via
 * `@creditkarma/thrift-typescript`. The new surface differs from the old
 * hand-written package in two important ways:
 *
 *  1. **Single struct + numeric enum** — instead of a discriminated union
 *     of `StreamRespEvent | ActionRequiredEvent | …`, there is now one
 *     `IRuntimeEvent` whose `type` is the numeric `RuntimeEventType` enum
 *     and whose `payload` is one `IRuntimeEventPayload` struct with every
 *     variant field optional. Narrow on `event.type === RuntimeEventType.X`
 *     at consumption sites.
 *  2. **No zod schemas** — `RuntimeEventSchema`, `RuntimeEventTypeSchema`
 *     etc. are gone. We accept the loss of runtime validation here per
 *     project owner directive.
 *
 * This file re-exports the protocol types under both their new `IXxx`
 * names and the legacy `RuntimeXxx` aliases that the rest of agent-core
 * already uses, plus defines small local types for the agent-core
 * internal vocabulary (`RuntimeToolCall`, `RuntimeToolCallStatus`,
 * `RuntimeRole`, `RuntimeMessageKind`, `RuntimeSessionStatus`,
 * `RuntimeTerminalStatus`) that were never IDL-bound.
 *
 * Daemon usage hint
 * -----------------
 * Phase 1: daemon emits `AgentMessageChunk` (see {@link ./agent-message.ts}).
 * Phase 2: daemon emits `RuntimeEvent` directly via `EventSink.pushRuntime`.
 *
 * Cloud impl hint
 * ---------------
 * Cloud-runtime always works with `RuntimeEvent` internally and translates
 * into `AgentMessageChunk` only in `ExchangeSink` for Phase 1 compatibility.
 */
export { RuntimeActionType, RuntimeDebugTraceLevel, RuntimeEventStatus, RuntimeEventType, RuntimeStopReasonType, } from '@mavis/protocol';
export { RUNTIME_EVENT_SCHEMA } from '@mavis/protocol';
//# sourceMappingURL=runtime-event.js.map