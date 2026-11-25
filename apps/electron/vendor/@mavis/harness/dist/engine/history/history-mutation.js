import { forkBoundary, planFork, selectForkPrefix } from './fork-plan.js';
import { containsHistoryMessage } from './history-records.js';
import { decodeRewindOperationData, encodeRewindOperationData, planRewind, } from './rewind-plan.js';
/** plan → projections → stage → publish; a staged operation resumes at projections. */
export async function rewindHistory(input) {
    const resumed = await input.history.resumeRewind?.({
        sessionId: input.sessionId,
        operationId: input.operationId,
    });
    if (resumed)
        return resumeRewind(input, resumed);
    const source = await readBoundarySource(input.history, input.sessionId, input.fromUserMessageIdInclusive, input.fromUserMessageIdInclusive);
    const plan = planRewind(input, source);
    const projections = await runRewindProjections(input, plan, plan.generation);
    const staged = await input.history.stageRewind({
        sessionId: input.sessionId,
        operationId: input.operationId,
        expectedRevision: plan.sourceRevision,
        sourceGeneration: plan.sourceGeneration,
        generation: plan.generation,
        active: plan.active,
        snapshots: plan.snapshots,
        operationData: encodeRewindOperationData(plan),
    });
    return rewindOutcome(plan, plan.generation, await staged.publish(), projections);
}
async function resumeRewind(input, staged) {
    const data = decodeRewindOperationData(staged.operationData, input);
    const projections = await runRewindProjections(input, data, staged.generation);
    const publication = await staged.publish({ allowRevisionChange: true });
    return rewindOutcome(data, staged.generation, publication, projections);
}
function rewindOutcome(data, generation, publication, projections) {
    return {
        generation,
        historyRevision: publication.revision,
        deletedMessageIds: data.deletedMessageIds,
        affectedTurnIds: data.affectedTurnIds,
        partiallyRetainedTurnIds: data.partiallyRetainedTurnIds,
        projections,
    };
}
function runRewindProjections(input, data, generation) {
    const plan = {
        sessionId: input.sessionId,
        operationId: input.operationId,
        rewindTurnDiff: data.rewindTurnDiff,
        generation,
        deletedMessageIds: data.deletedMessageIds,
        affectedTurnIds: data.affectedTurnIds,
        fullyDeletedTurnIds: data.fullyDeletedTurnIds,
        partiallyRetainedTurnIds: data.partiallyRetainedTurnIds,
    };
    return runProjections(input.projections, (projection) => projection.rewind?.bind(projection, plan));
}
export async function forkHistory(input) {
    const plan = planFork(input, await readForkPrefix(input));
    const forkPlan = {
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        operationId: input.operationId,
        generation: plan.generation,
        retainedTurnIds: plan.retainedTurnIds,
    };
    const projections = await runProjections(input.projections, (projection) => projection.fork?.bind(projection, forkPlan));
    const staged = await input.history.stageFork({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        operationId: input.operationId,
        generation: plan.generation,
        active: plan.active,
        snapshots: plan.snapshots,
    });
    const publication = await staged.publish();
    return {
        generation: plan.generation,
        historyRevision: publication.revision,
        retainedTurnIds: plan.retainedTurnIds,
        projections,
    };
}
export async function inspectHistoryForkBoundary(input) {
    await readForkPrefix(input);
    return { settled: true };
}
async function readForkPrefix(input) {
    const source = await readBoundarySource(input.history, input.sourceSessionId, forkBoundary(input), input.beforeUserMessageId);
    return selectForkPrefix(input, source);
}
/** A missing user boundary may still be persisted by a running Turn; the Host decides. */
async function readBoundarySource(history, sessionId, boundary, waitForUserMessageId) {
    const initial = await history.read(sessionId);
    if (!boundary || containsHistoryMessage(initial, boundary) || !waitForUserMessageId) {
        return initial;
    }
    const waited = await history.waitForUserMessage?.({
        sessionId,
        userMessageId: waitForUserMessageId,
    });
    return waited ?? initial;
}
/** Runs each projection in order; a throw is isolated into its result. */
async function runProjections(projections, select) {
    const results = [];
    for (const projection of projections ?? []) {
        const run = select(projection);
        if (!run)
            continue;
        try {
            results.push({ name: projection.name, ...(await run()) });
        }
        catch (error) {
            results.push({ name: projection.name, status: 'failed', error });
        }
    }
    return results;
}
//# sourceMappingURL=history-mutation.js.map