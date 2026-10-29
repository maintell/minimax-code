import { INTERNAL_TURN_ID_PREFIX } from '@mavis/shared/turn-identity';
const PLAN_CONTINUATION_IDENTITY_PREFIXES = [
    `${INTERNAL_TURN_ID_PREFIX}plan-enter:`,
    `${INTERNAL_TURN_ID_PREFIX}plan-review:`,
    `${INTERNAL_TURN_ID_PREFIX}plan-review-feedback:`,
    'plan-enter:',
    'plan-review:',
    'plan-review-feedback:',
];
export async function recoverPlanLifecycleAndImplementationQueue(options) {
    let completed = 0;
    const failures = [];
    try {
        completed = await options.recoverLifecycle();
    }
    catch (error) {
        failures.push(error);
    }
    if (options.dispatch && !options.signal?.aborted) {
        try {
            await options.recoverImplementationQueue();
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Plan lifecycle recovery was incomplete');
    }
    return completed;
}
export async function recoverPlanImplementationQueue(options) {
    const failures = [];
    for (const sessionId of await options.queue.listPendingSessionIds()) {
        if (options.signal?.aborted)
            return;
        try {
            await recoverPlanImplementationQueueSession(options, sessionId);
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Approved Plan implementation Queue recovery was incomplete');
    }
}
async function recoverPlanImplementationQueueSession(options, sessionId) {
    const items = await options.queue.list(sessionId);
    if (options.signal?.aborted)
        return;
    if (!options.entryEnabled()) {
        await cancelQueuedPlanEntries(options.queue, sessionId, items, options.signal);
    }
    if (!options.signal?.aborted && items.some(isApprovedPlanImplementation)) {
        await options.dispatchQueue(sessionId);
    }
}
async function cancelQueuedPlanEntries(queue, sessionId, items, signal) {
    for (const item of items) {
        if (signal?.aborted)
            return;
        if (item.message.clientIntent !== 'plan-entry')
            continue;
        const cancelled = await queue.cancel(sessionId, item.itemId);
        if (cancelled === 'not_editable') {
            throw new Error(`Plan entry Queue item could not be cancelled during gate-off recovery: ${sessionId}/${item.itemId}`);
        }
    }
}
function isApprovedPlanImplementation(item) {
    const identity = item.clientRequestId;
    return (item.source === 'questionnaire' &&
        identity !== undefined &&
        isPlanContinuationIdentity(identity) &&
        item.requestedTurnId === identity);
}
function isPlanContinuationIdentity(identity) {
    return PLAN_CONTINUATION_IDENTITY_PREFIXES.some((prefix) => identity.length > prefix.length && identity.startsWith(prefix));
}
//# sourceMappingURL=implementation-queue-recovery.js.map