import { recoverPtcCrashState, } from '../../messages/ptc/crash-recovery.js';
import { SESSION_SHUTDOWN_SOURCE } from './capabilities.js';
import { logger } from '../../../../infra/logging/logger.js';
export const SESSION_INTERRUPTION_MESSAGE = 'This session was interrupted because the previous local runtime stopped.';
/** `errorSource` of a Session whose running Turn the previous process left behind. */
const SESSION_CRASH_RECOVERY_SOURCE = 'crash-recovery';
/**
 * Whether the Session's last Turn was cut off by the app stopping, by a
 * shutdown abort or by crash recovery, and not stopped by anyone.
 */
export function stoppedByRestart(session) {
    return ((session.status === 'aborted' && session.errorSource === SESSION_SHUTDOWN_SOURCE) ||
        (session.status === 'interrupted' && session.errorSource === SESSION_CRASH_RECOVERY_SOURCE));
}
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
    /** Display-only: a failed fact replay must not keep this or later Sessions stale. */
    async recoverChildExecutions(sessionId) {
        try {
            await this.options.subagentExecutions?.recover(sessionId);
        }
        catch (error) {
            logger.warn({ error: error instanceof Error ? error.message : String(error), sessionId }, 'Subagent execution recovery failed; Session is still interrupted');
        }
    }
    async recoverPreviousProcess(input) {
        if (!Number.isFinite(input.processStartedAtMs)) {
            throw new TypeError('processStartedAtMs must be finite');
        }
        const interruptedSessionIds = [];
        const recoveredPtcTurnIds = new Set();
        let candidates;
        do {
            candidates = await this.options.sessions.listStalePiSessions({
                updatedBeforeMs: input.processStartedAtMs,
                ...(input.protectedSessionIds?.length
                    ? { excludedSessionIds: input.protectedSessionIds }
                    : {}),
                limit: this.batchSize,
            });
            // Do this before changing `started` to `interrupted`. If the process
            // stops between the two durable stores, the next startup still sees the
            // Session as stale and retries the PTC closure instead of losing facts.
            for (const turnId of await this.recoverInterruptedPtcState({
                processStartedAtMs: input.processStartedAtMs,
                interruptedSessionIds: candidates.map((candidate) => candidate.sessionId),
                terminalFacts: input.terminalFacts,
            })) {
                recoveredPtcTurnIds.add(turnId);
            }
            for (const candidate of candidates) {
                // Close exact durable child-turn markers before clearing stale Session state.
                await this.recoverChildExecutions(candidate.sessionId);
                const updated = await this.options.sessions.update(candidate.sessionId, {
                    status: 'interrupted',
                    errorMessage: SESSION_INTERRUPTION_MESSAGE,
                    errorCode: undefined,
                    errorSource: SESSION_CRASH_RECOVERY_SOURCE,
                    errorDetail: undefined,
                    errorProviderId: undefined,
                });
                if (updated?.status === 'interrupted') {
                    interruptedSessionIds.push(candidate.sessionId);
                }
            }
        } while (candidates.length === this.batchSize);
        for (const turnId of await this.recoverInterruptedPtcState({
            processStartedAtMs: input.processStartedAtMs,
            interruptedSessionIds: [],
            terminalFacts: input.terminalFacts,
        })) {
            recoveredPtcTurnIds.add(turnId);
        }
        return {
            interruptedSessionIds,
            ...(recoveredPtcTurnIds.size > 0 ? { recoveredPtcTurnIds: [...recoveredPtcTurnIds] } : {}),
        };
    }
    async recoverInterruptedPtcState(input) {
        const { messages, canonicalHistory } = this.options;
        if (!messages || !canonicalHistory)
            return [];
        return (await recoverPtcCrashState({ messages, history: canonicalHistory }, input))
            .recoveredTurnIds;
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