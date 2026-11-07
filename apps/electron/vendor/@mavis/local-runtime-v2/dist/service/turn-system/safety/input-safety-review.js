import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
/** Only terminal delivery waits for input review; approved output can still stream. */
export function gateTerminalOnInputReview(inner, review, shouldDiscard, signal) {
    const isTerminal = (event) => event.type === RuntimeEventType.SESSION_STATUS &&
        (event.payload?.status === RuntimeEventStatus.COMPLETED ||
            event.payload?.status === RuntimeEventStatus.ABORTED ||
            event.payload?.status === RuntimeEventStatus.FAILED);
    const shouldDiscardTerminal = (event) => isTerminal(event) &&
        (shouldDiscard() ||
            (signal?.aborted === true && event.payload?.status !== RuntimeEventStatus.ABORTED));
    return {
        pushRuntime: async (event) => {
            if (isTerminal(event)) {
                await review;
                if (shouldDiscardTerminal(event))
                    return;
            }
            await inner.pushRuntime(event);
        },
        appendEvents: async (events) => {
            if (!events.some(isTerminal)) {
                await inner.appendEvents(events);
                return;
            }
            await review;
            const accepted = events.filter((event) => !shouldDiscardTerminal(event));
            if (accepted.length > 0)
                await inner.appendEvents(accepted);
        },
    };
}
export async function waitForInputReview(review, signal) {
    if (!signal)
        return review;
    if (signal.aborted)
        return;
    let onAbort;
    const aborted = new Promise((resolve) => {
        onAbort = resolve;
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        await Promise.race([review, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=input-safety-review.js.map