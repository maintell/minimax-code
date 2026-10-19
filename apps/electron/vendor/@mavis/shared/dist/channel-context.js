/**
 * Channel Context & Trace Context types for the multi-channel plugin architecture.
 *
 * ChannelContext unifies the scattered context objects (ChannelMessageContext, MessageOrigin,
 * RequestContext) into a single object that flows through the entire message pipeline.
 *
 * TraceContext provides distributed-tracing semantics (traceId + spanId + parentSpanId)
 * for end-to-end message tracing from IM platform to agent response.
 */
import { randomUUID, getRandomValues } from 'node:crypto';
// ---------------------------------------------------------------------------
// Factory: TraceContext
// ---------------------------------------------------------------------------
/**
 * Generate a 32-char hex trace ID (UUID without dashes).
 * Compatible with the existing `RequestContext.traceId` format.
 */
function generateTraceId() {
    return randomUUID().replace(/-/g, '');
}
/** Generate a 16-char hex span ID. */
function generateSpanId() {
    const bytes = new Uint8Array(8);
    getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Create a root TraceContext for a new inbound message. */
export function createTraceContext(platform, clientName, platformMessageId) {
    return {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        source: `${platform}:${clientName}`,
        ...(platformMessageId !== undefined ? { platformMessageId } : {}),
        startedAt: Date.now(),
    };
}
/** Derive a child span under an existing trace (e.g. agent call, tool execution). */
export function childSpan(parent) {
    return {
        traceId: parent.traceId,
        spanId: generateSpanId(),
        parentSpanId: parent.spanId,
        source: parent.source,
        ...(parent.platformMessageId !== undefined
            ? { platformMessageId: parent.platformMessageId }
            : {}),
        startedAt: Date.now(),
    };
}
/**
 * Build a ChannelContext from parsed event data.
 *
 * The `params` shape is intentionally decoupled from `ChannelParsedEvent` to avoid
 * circular imports — callers extract the needed fields from their event type.
 */
export function createChannelContext(params, clientName) {
    const trace = createTraceContext(params.platform, clientName, params.messageId);
    return {
        platform: params.platform,
        clientName,
        chatId: params.chatId,
        chatType: params.chatType,
        senderId: params.senderId,
        ...(params.senderName !== undefined ? { senderName: params.senderName } : {}),
        ...(params.locale !== undefined ? { locale: params.locale } : {}),
        platformMessageId: params.messageId,
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        hasMention: params.hasMention,
        bindingKey: `${clientName}:${params.chatId}:${params.senderId}`,
        trace,
        receivedAt: params.timestamp ?? Date.now(),
    };
}
// ---------------------------------------------------------------------------
// Compatibility bridges
// ---------------------------------------------------------------------------
/**
 * Convert a ChannelContext to the legacy `RequestContext` shape.
 * This enables gradual migration — HTTP/Hono handlers that expect RequestContext
 * can consume the trace ID from the IM pipeline.
 */
export function toRequestContext(ctx) {
    return { traceId: ctx.trace.traceId };
}
/** Convert a standalone TraceContext to RequestContext. */
export function traceToRequestContext(trace) {
    return { traceId: trace.traceId };
}
//# sourceMappingURL=channel-context.js.map