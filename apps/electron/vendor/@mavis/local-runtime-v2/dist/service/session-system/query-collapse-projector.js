import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { Role } from '@mavis/agent-core/protocol/agent-message';
/** Maintains the query display sidecar from committed Session projections. */
export function createQueryCollapseProjector(options) {
    return {
        projectRuntimeEvent: async (input) => {
            const status = terminalStatus(input.event);
            if (!status)
                return;
            const current = await options.state.findProcessingByCurrentTurn(input.context.sessionId, input.context.turnId);
            if (!current)
                return;
            const forceExpanded = await shouldForceExpanded(options, input, status);
            const finished = await options.state.finish({
                sessionId: current.sessionId,
                queryKey: current.queryKey,
                currentTurnId: input.context.turnId,
                forceExpanded,
            });
            if (finished)
                writeQueryCollapseView(options.stream, finished);
        },
        projectHistoryCommitted: async (input) => {
            if (!isForceExpansionReconciliation(input.change.operation.kind))
                return;
            await forceExpandAndPublish(options, input.context);
        },
        projectFailure: (input) => finishAndPublish(options, input, true),
    };
}
async function shouldForceExpanded(options, input, status) {
    if (status !== RuntimeEventStatus.COMPLETED)
        return true;
    const messages = await options.messages.listTurn(input.context.sessionId, input.context.turnId);
    return !messages.some(hasStableAssistantBody) || messages.some(hasSafetyReviewUnknown);
}
function hasStableAssistantBody(message) {
    if (message.role !== Role.Assistant)
        return false;
    const body = message.msg_content ?? message.msgContent ?? message.content;
    return typeof body === 'string' && body.trim().length > 0;
}
function hasSafetyReviewUnknown(message) {
    return Reflect.get(message, 'safety_review_unknown') === true;
}
async function forceExpandAndPublish(options, input) {
    const forced = await options.state.forceExpandForTurn(input.sessionId, input.turnId);
    if (forced)
        writeQueryCollapseView(options.stream, forced);
}
async function finishAndPublish(options, input, forceExpanded) {
    const current = await options.state.findProcessingByCurrentTurn(input.sessionId, input.turnId);
    if (!current)
        return;
    const finished = await options.state.finish({
        sessionId: current.sessionId,
        queryKey: current.queryKey,
        currentTurnId: input.turnId,
        forceExpanded,
    });
    if (finished)
        writeQueryCollapseView(options.stream, finished);
}
export function writeQueryCollapseView(stream, state) {
    stream.write({
        identity: `query-collapse:${state.queryKey}:${state.currentTurnId}:${String(state.updatedAtMs)}`,
        sessionId: state.sessionId,
        turnId: state.currentTurnId,
        kind: 'query-collapse-view',
        data: {
            queryKey: state.queryKey,
            currentTurnId: state.currentTurnId,
            forceExpanded: state.forceExpanded,
            processingStartedAtMs: state.processingStartedAtMs,
            ...(state.processingFinishedAtMs === undefined
                ? {}
                : { processingFinishedAtMs: state.processingFinishedAtMs }),
        },
    });
}
function terminalStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    switch (event.payload.status) {
        case RuntimeEventStatus.COMPLETED:
        case RuntimeEventStatus.FAILED:
        case RuntimeEventStatus.ABORTED:
            return event.payload.status;
        default:
            return undefined;
    }
}
function isForceExpansionReconciliation(kind) {
    return kind === 'output-recall' || kind === 'network-reconcile';
}
//# sourceMappingURL=query-collapse-projector.js.map