import { createHash } from 'node:crypto';
/** Copies only resumable pending UI state; historical Fork callers do not invoke this capability. */
export async function copyPendingQuestionnaireForFork(store, input) {
    const source = await store.findLatestPendingBySession(input.sourceSessionId);
    if (!source)
        return;
    const prepared = input.prepareSource
        ? input.prepareSource(source)
        : { request: source.request, preserveExecutionIdentity: true };
    if (!prepared)
        return;
    const request = prepared.preserveExecutionIdentity
        ? prepared.request
        : withoutExecutionIdentity(prepared.request);
    const requestId = forkQuestionnaireRequestId(input.operationId, source.requestId);
    await store.upsert({
        requestId,
        sessionId: input.targetSessionId,
        ...(source.agentName ? { agentName: source.agentName } : {}),
        ...(prepared.preserveExecutionIdentity && source.msgId ? { msgId: source.msgId } : {}),
        request: {
            ...request,
            id: requestId,
            requester: prepared.preserveExecutionIdentity
                ? { ...request.requester, sessionId: input.targetSessionId }
                : childOwnedRequester(request, input.targetSessionId),
        },
        // Keep the AskUser v2 column with the copy: request_json already carries
        // responseMode, and a NULL column would turn the fork into a legacy row
        // that gates the forked session's queue and Plan entry.
        ...(source.responseMode ? { responseMode: source.responseMode } : {}),
        status: 'pending',
        createdAt: source.createdAt,
    });
}
function withoutExecutionIdentity(request) {
    const copy = { ...request };
    delete copy.tool;
    return copy;
}
function childOwnedRequester(request, sessionId) {
    return {
        sessionId,
        ...(request.requester?.agentName ? { agentName: request.requester.agentName } : {}),
    };
}
function forkQuestionnaireRequestId(operationId, sourceRequestId) {
    const identity = createHash('sha256')
        .update(operationId)
        .update('\0')
        .update(sourceRequestId)
        .digest('hex')
        .slice(0, 24);
    return `ask_fork_${identity}`;
}
//# sourceMappingURL=fork.js.map