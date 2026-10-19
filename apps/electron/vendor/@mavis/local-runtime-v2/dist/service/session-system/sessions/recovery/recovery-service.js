export const SESSION_INTERRUPTION_MESSAGE = 'This session was interrupted because the previous local runtime stopped.';
const DEFAULT_RECOVERY_BATCH_SIZE = 1000;
/**
 * One startup-only Session recovery policy.
 *
 * Runtime reads and later Turn admission never mutate stale state. The owner
 * invokes this before HTTP starts, while the new process has admitted no work.
 */
export class SessionRecoveryService {
    options;
    batchSize;
    constructor(options) {
        this.options = options;
        this.batchSize = normalizeBatchSize(options.batchSize);
    }
    async recoverPreviousProcess(input) {
        if (!Number.isFinite(input.processStartedAtMs)) {
            throw new TypeError('processStartedAtMs must be finite');
        }
        const interruptedSessionIds = [];
        let candidates;
        do {
            candidates = await this.options.sessions.listStalePiSessions({
                updatedBeforeMs: input.processStartedAtMs,
                ...(input.protectedSessionIds?.length
                    ? { excludedSessionIds: input.protectedSessionIds }
                    : {}),
                limit: this.batchSize,
            });
            for (const candidate of candidates) {
                const updated = await this.options.sessions.update(candidate.sessionId, {
                    status: 'interrupted',
                    errorMessage: SESSION_INTERRUPTION_MESSAGE,
                    errorCode: undefined,
                    errorSource: 'crash-recovery',
                    errorDetail: undefined,
                    errorProviderId: undefined,
                });
                if (updated?.status === 'interrupted') {
                    interruptedSessionIds.push(candidate.sessionId);
                }
            }
        } while (candidates.length === this.batchSize);
        return { interruptedSessionIds };
    }
}
function normalizeBatchSize(value) {
    if (value === undefined)
        return DEFAULT_RECOVERY_BATCH_SIZE;
    if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError('Session recovery batchSize must be positive');
    }
    return Math.min(Math.floor(value), DEFAULT_RECOVERY_BATCH_SIZE);
}
//# sourceMappingURL=recovery-service.js.map