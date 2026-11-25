import { readCompactionAttemptId } from '../compaction/context-compaction.js';
export class AgentHistoryOperationIdentityError extends Error {
    reason;
    operationId;
    name = 'AgentHistoryOperationIdentityError';
    constructor(reason, operationId) {
        super(`Agent history operation ${reason}: "${operationId}".`);
        this.reason = reason;
        this.operationId = operationId;
    }
}
export class AgentHistoryOperationReplayCoordinator {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    rejectPreparation(change, error) {
        const compactionAttemptId = tryReadCompactionAttemptId(change.metadata);
        return this.dependencies.lane.enqueue(() => compactionAttemptId
            ? this.dependencies.writer.failCompactionAttempt(this.dependencies.context, compactionAttemptId, error)
            : Promise.reject(error), Boolean(compactionAttemptId));
    }
    enqueuePrepared(prepared, operation) {
        return this.dependencies.lane.enqueue(operation, false, this.blockedCompactionSettlement(prepared));
    }
    resolve(replay, prepared) {
        if (replay.fingerprint === prepared.fingerprint)
            return replay.execution;
        const compactionAttemptId = readCompactionAttemptId(prepared.change.metadata);
        return this.enqueuePrepared(prepared, () => compactionAttemptId
            ? this.dependencies.commit(prepared.change)
            : Promise.reject(new AgentHistoryOperationIdentityError('conflict', prepared.operationId)));
    }
    blockedCompactionSettlement(prepared) {
        const compactionAttemptId = readCompactionAttemptId(prepared.change.metadata);
        if (!compactionAttemptId)
            return undefined;
        return (error) => this.dependencies.writer.failCompactionAttempt(this.dependencies.context, compactionAttemptId, error);
    }
}
function tryReadCompactionAttemptId(metadata) {
    try {
        return readCompactionAttemptId(metadata);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=history-operation-replay.js.map