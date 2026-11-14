import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
/** Rejections that only mean "not now"; a Plan review card holds the session like an active Turn. */
const TRANSIENT_REJECTIONS = {
    'active-turn': true,
    'compaction-active': true,
    'session-mutating': true,
    'policy:plan:lifecycle-active': true,
};
/**
 * A ready Plugin preparation card whose continuation met a busy session: the
 * answer is saved and the owner's reconciler resumes it once the session is
 * free, so this is a deferral, not a delivery failure.
 */
export function isDeferredPluginContinuation(record, err) {
    return (err instanceof ConversationTurnRejectedError &&
        TRANSIENT_REJECTIONS[err.reason] === true &&
        record.request.mode === 'plugin-preparation');
}
/** Thrown by owned-action reconciliation when only busy-session deferrals remain. */
export class OwnedActionDeferredError extends Error {
    requestIds;
    name = 'OwnedActionDeferredError';
    constructor(requestIds) {
        super(`Owned Questionnaire continuation deferred until the session is idle: ${requestIds.join(', ')}`);
        this.requestIds = requestIds;
    }
}
//# sourceMappingURL=owned-action-deferral.js.map