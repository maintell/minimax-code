/**
 * A Turn that ends while a side event is still buffered must not lose it; a
 * failure here cannot change the Turn's own outcome.
 */
export async function closeSideEventRouter(router, turn, logger) {
    if (!router)
        return;
    try {
        await router.close();
    }
    catch (error) {
        logger?.warn?.({
            session_id: turn.sessionId,
            turn_id: turn.turnId,
            error: error instanceof Error ? error.message : String(error),
        }, '[turn] side-event router close failed');
    }
}
/**
 * A stopped writer silently discards every event it is handed: `deliverRuntime`
 * returns before releasing anything once `blocked` or `networkStopped` is set,
 * and only a FAILED `SESSION_STATUS` survives a network stop. Routing a side
 * event into one therefore loses it with no error and no log, so a stopped
 * writer must be treated exactly like a detached one.
 */
function hasStopped(writer) {
    return writer.blocked || writer.networkStopped;
}
export function createTurnSideEventRouter(fallback) {
    let active;
    let retained;
    let closed = false;
    const buffered = [];
    const flush = async (writer) => {
        while (buffered.length > 0) {
            await writer.appendEvents(buffered.splice(0, buffered.length));
        }
    };
    return {
        attach: async (writer) => {
            active = writer;
            retained = writer;
            await flush(writer);
        },
        detach: (writer) => {
            if (active === writer)
                active = undefined;
        },
        appendEvents: async (events) => {
            if (events.length === 0)
                return;
            if (closed) {
                await fallback.appendEvents([...events]);
                return;
            }
            const writer = active;
            // A stopped writer would drop these; hold them for the next attempt instead.
            if (!writer || hasStopped(writer)) {
                buffered.push(...events);
                return;
            }
            await writer.appendEvents([...events]);
        },
        discardPendingMessage: (messageId) => {
            (active ?? retained)?.discardPendingMessage(messageId);
        },
        close: async () => {
            closed = true;
            active = undefined;
            if (buffered.length === 0)
                return;
            await flush(retained ?? fallback);
        },
    };
}
//# sourceMappingURL=turn-side-event-router.js.map