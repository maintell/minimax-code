import { compareAndSetSessionInteractionModeInTransaction, readSessionInteractionModeInTransaction, transitionSessionInteractionModeInTransaction, } from './repo/drizzle.js';
export function createSessionInteractionModeCapability(options) {
    const nowMs = options.nowMs ?? Date.now;
    const readInTransaction = (db, sessionId) => readSessionInteractionModeInTransaction(db, sessionId);
    const compareAndSetInTransaction = (db, sessionId, expected, next) => compareAndSetSessionInteractionModeInTransaction(db, {
        sessionId,
        expected,
        next,
        updatedAtMs: nowMs(),
    });
    const transitionInTransaction = (db, sessionId, expected, next) => transitionSessionInteractionModeInTransaction(db, {
        sessionId,
        expected,
        next,
        updatedAtMs: nowMs(),
    });
    const transition = async (sessionId, expected, next) => options.db.transaction((tx) => transitionInTransaction(tx, sessionId, expected, next), {
        behavior: 'immediate',
    });
    return {
        get: async (sessionId) => readInTransaction(options.db, sessionId),
        setPlan: (sessionId) => transition(sessionId, 'default', 'plan'),
        setGoal: (sessionId) => transition(sessionId, 'default', 'goal'),
        ensureDefault: (sessionId) => transition(sessionId, 'plan', 'default'),
        readInTransaction,
        compareAndSetInTransaction,
        transitionInTransaction,
    };
}
//# sourceMappingURL=interaction-mode-capability.js.map