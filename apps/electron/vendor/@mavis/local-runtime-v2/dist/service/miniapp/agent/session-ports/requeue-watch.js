import { modelSelectionFromQueue } from '../model-selection.js';
import { errorFields } from './turn-follow.js';
/**
 * A steer the running turn answers before reading goes back to the session queue as an item the
 * runtime builds, possibly merged with other unread steers, and the next turn runs on the model
 * that item carries when it is dispatched. The queue's committed `queued` events of the session
 * name the candidate items; the one carrying `userMessageId` is read once the running turn
 * ended, so every call following that turn reports the same model.
 */
export function watchRequeue(options, sessionId, userMessageId) {
    const candidates = new Set();
    let lookup;
    const findItem = async () => {
        for (const itemId of candidates) {
            const item = await readItem(options, sessionId, itemId);
            if (item && carries(item, userMessageId)) {
                const model = modelSelectionFromQueue(item.model);
                return { itemId, ...(model ? { model } : {}) };
            }
        }
        return undefined;
    };
    const unsubscribe = options.eventBus.subscribe({
        next(event) {
            if (event.type !== 'session.queue.updated')
                return;
            const { payload } = event;
            if (payload.sessionId === sessionId && payload.status === 'queued' && payload.itemId) {
                candidates.add(payload.itemId);
            }
        },
    });
    return {
        resolve() {
            lookup ??= findItem();
        },
        item() {
            lookup ??= findItem();
            return lookup;
        },
        dispose: unsubscribe,
    };
}
async function readItem(options, sessionId, itemId) {
    try {
        return await options.queue.get(sessionId, itemId);
    }
    catch (error) {
        options.logger.warn({ stage: 'requeued-model', sessionId, itemId, ...errorFields(error) }, 'Mini App Agent could not read the queue item its steered text went back to');
        return undefined;
    }
}
function carries(item, userMessageId) {
    if (item.userMessageId === userMessageId)
        return true;
    return (item.immediateSendBatch?.members ?? []).some((member) => member.userMessageId === userMessageId);
}
//# sourceMappingURL=requeue-watch.js.map