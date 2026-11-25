import { isAbortSignalLike } from '../../agent-host/accepted-lease.js';
import { TurnYieldControl } from '../../agent-host/turn-yield/turn-yield-control.js';
/** One run's yield control; a `yieldSignal` that is not an AbortSignal rejects the run. */
export function createRunYield(limits, yieldSignal) {
    if (yieldSignal !== undefined && !isAbortSignalLike(yieldSignal)) {
        throw new TypeError('HarnessRunInput.yieldSignal must be an AbortSignal.');
    }
    return new TurnYieldControl(limits, yieldSignal);
}
/**
 * Routes the run's approval requests and synchronous user questions through
 * the yield holds. An inactive control keeps the scope as it is.
 */
export function yieldableRunScope(scope, control) {
    if (!control.active)
        return scope;
    const { permissions, tools } = scope.host;
    return {
        ...scope,
        host: {
            ...scope.host,
            permissions: heldPermissions(permissions, control),
            tools: {
                ...tools,
                contribute: async (request) => heldQuestions(await tools.contribute(request), control),
            },
        },
    };
}
function heldPermissions(permissions, control) {
    const approval = permissions.approval;
    if (!approval)
        return permissions;
    return {
        ...permissions,
        approval: {
            request: (input) => control.hold('approval', input.signal, (signal) => approval.request({ ...input, signal })),
        },
    };
}
function heldQuestions(contribution, control) {
    const questions = contribution.tools.questions;
    if (!questions?.await)
        return contribution;
    const wait = questions.await.bind(questions);
    const held = {
        begin: (ctx, input, signal) => questions.begin(ctx, input, signal),
        await: (handle, signal) => control.hold('user-input', signal, (merged) => wait(handle, merged)),
        featureEnable: questions.featureEnable,
        askUserDescription: questions.askUserDescription,
    };
    return { ...contribution, tools: { ...contribution.tools, questions: held } };
}
//# sourceMappingURL=run-yield.js.map