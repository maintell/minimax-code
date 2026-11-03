export function createSessionsService(repository) {
    return repository;
}
/** Owned update fields present as undefined clear the stored values (see rewind commit). */
const CLEARED_ERROR = {
    errorMessage: undefined,
    errorCode: undefined,
    errorSource: undefined,
    errorDetail: undefined,
    errorProviderId: undefined,
};
export function createSessionStateWriter(repository) {
    return {
        // A starting Turn supersedes the Session's current error. History keeps the
        // failed messages; only the Session-level status fields are cleared.
        markStarted: (input) => repository.applyAgentState({ ...input, update: { status: 'started', ...CLEARED_ERROR } }),
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