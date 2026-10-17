export function createSessionsService(repository) {
    return repository;
}
export function createSessionStateWriter(repository) {
    return {
        markStarted: (input) => repository.applyAgentState({ ...input, update: { status: 'started' } }),
        markIdle: (input) => repository.applyAgentState({ ...input, update: { status: 'idle' } }),
        markTerminal: (input) => repository.applyAgentState({
            ...input,
            terminalOutcome: input.outcome,
            update: terminalStateUpdate(input),
        }),
    };
}
export function createSessionAbortWriter(repository) {
    return {
        markAborted: async ({ sessionId, errorMessage }) => Boolean(await repository.update(sessionId, { status: 'aborted', errorMessage })),
    };
}
export function createSessionExecutionSource(repository, readiness) {
    return {
        getExecutionSnapshot: async (sessionId) => {
            await readiness?.ensureExecutionReady(sessionId);
            const record = await repository.get(sessionId);
            return record ? freezeExecutionSnapshot(record) : undefined;
        },
    };
}
function terminalStateUpdate(input) {
    if (input.outcome === 'completed')
        return { status: 'idle' };
    if (input.outcome === 'aborted')
        return { status: 'aborted' };
    return {
        status: 'error',
        errorMessage: input.errorMessage ?? 'Agent turn failed',
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        ...(input.errorSource ? { errorSource: input.errorSource } : {}),
        ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
    };
}
function freezeExecutionSnapshot(record) {
    const runLocation = record.runLocation ? Object.freeze({ ...record.runLocation }) : undefined;
    return Object.freeze({ ...record, runLocation });
}
//# sourceMappingURL=capabilities.js.map