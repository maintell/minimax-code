import { lockSessionMemoryRecallInTransaction } from '../../service/session-system/index.js';
export function createMemoryRecallAdmissionPolicy() {
    return {
        applyInTransaction(db, input) {
            if (!input.genuineUserMessage)
                return undefined;
            const result = lockSessionMemoryRecallInTransaction(db, {
                sessionId: input.sessionId,
                lockedAtMs: input.candidateCreatedAtMs,
            });
            return result === 'not-found' ? 'invalid-session' : undefined;
        },
    };
}
//# sourceMappingURL=memory-recall-admission.js.map