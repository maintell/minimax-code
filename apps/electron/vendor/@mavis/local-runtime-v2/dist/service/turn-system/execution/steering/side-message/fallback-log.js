/**
 * Records each side message that hit a turn-switch race in the structured
 * runtime log: which race branch it took and whether the Queue fallback
 * queued it (with the item id) or failed. The record shape
 * (`mavis.side_message_fallback.v1`, `eventType`, `eventAtMs`, `payload`)
 * matches the other runtime decision events diagnostics read per Session.
 */
export function createSideMessageFallbackLog(logger, nowMs = Date.now) {
    const sideMessageLogger = logger.child({ component: 'local-runtime.side-message' });
    return (event) => {
        sideMessageLogger
            .child({
            sessionId: event.sessionId,
            ...(event.targetTurnId ? { turnId: event.targetTurnId } : {}),
        })
            .info(event.outcome === 'queued'
            ? 'Side message fell back to the Session Queue'
            : 'Side message Queue fallback failed', {
            schema: 'mavis.side_message_fallback.v1',
            eventType: 'side_message.steer_fallback',
            eventAtMs: nowMs(),
            payload: { ...event },
        });
    };
}
//# sourceMappingURL=fallback-log.js.map