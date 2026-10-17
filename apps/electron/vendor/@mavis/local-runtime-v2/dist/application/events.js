const greetingNotificationObservations = new WeakSet();
export function createRuntimeGlobalEventWriter(options) {
    return (event) => {
        if (options.isClosed())
            return;
        if (event.type === 'message.rewind' && event.payload.contextReset === true) {
            options.notifyContextReset?.(event.payload.sessionId);
        }
        if (event.type === 'session.deleted') {
            options.notifySessionDeleted?.(event.payload.sessionId);
        }
        notifyGreetingTurnTerminal(options.notifyGreetingTurnTerminal, event);
        options.write({ ...event, timestamp: options.nowMs(), source: 'local-runtime' });
    };
}
/** Adds cross-capability Turn observation before the committed event reaches the process bus. */
export function composeRuntimeGlobalEventWriter(options) {
    return createRuntimeGlobalEventWriter({
        ...options,
        write: (event) => {
            if (event.type === 'session.start' && event.payload.turnId) {
                options.observeTurn({
                    sessionId: event.payload.sessionId,
                    turnId: event.payload.turnId,
                });
            }
            options.write(event);
        },
    });
}
function notifyGreetingTurnTerminal(notify, event) {
    const terminal = terminalGreetingStatus(event);
    if (!terminal || !notify)
        return;
    let notification;
    try {
        notification = notify(terminal.turnId, terminal.status);
    }
    catch {
        return;
    }
    if (notification === undefined)
        return;
    greetingNotificationObservations.add(consumeGreetingNotification(notification));
}
async function consumeGreetingNotification(notification) {
    try {
        await notification;
    }
    catch {
        // Greeting persistence is a retryable observation after the terminal event.
    }
}
function terminalGreetingStatus(event) {
    switch (event.type) {
        case 'session.finish':
            return { turnId: event.payload.turnId, status: 'completed' };
        case 'session.error':
            return { turnId: event.payload.turnId, status: 'failed' };
        case 'session.abort':
            return { turnId: event.payload.turnId, status: 'cancelled' };
        default:
            return undefined;
    }
}
/** A committed business result remains primary when event publication or reporting fails. */
export function publishBestEffort(publisher, event, onFailure) {
    try {
        publisher(event);
    }
    catch (error) {
        try {
            onFailure?.(event, error);
        }
        catch {
            // A committed business result remains primary.
        }
    }
}
/** Adapts the process EventBus to a cancellation-owned async iterator. */
export async function* watchGlobalEvents(subscribe, signal) {
    yield* watchProcessEvents(subscribe, signal);
}
/** Adapts a process-local subscription to a cancellation-owned async iterator. */
export async function* watchProcessEvents(subscribe, signal) {
    if (signal?.aborted)
        return;
    const queued = [];
    let wake;
    const unsubscribe = subscribe((event) => {
        queued.push(event);
        wake?.();
        wake = undefined;
    });
    const abort = () => {
        wake?.();
        wake = undefined;
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (!signal?.aborted) {
            const event = queued.shift();
            if (event) {
                yield event;
                continue;
            }
            await new Promise((resolve) => {
                wake = resolve;
            });
        }
    }
    finally {
        signal?.removeEventListener('abort', abort);
        unsubscribe();
    }
}
//# sourceMappingURL=events.js.map