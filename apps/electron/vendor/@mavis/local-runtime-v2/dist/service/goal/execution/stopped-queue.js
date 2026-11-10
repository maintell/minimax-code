/**
 * End the Session's Queue pause for a Goal resume.
 *
 * The stop that paused the Goal also paused the Queue whenever work was still
 * pending, and an ordinary FIFO claim fails closed while a pause stands: the
 * resumed Goal's continuation would sit behind it with no Turn, no wait reason
 * and nothing that ever starts it (spec §6). Resuming the Goal is a return to
 * this Session's work, the same decision a confirmed composer send into a
 * paused Queue makes, so it ends the pause.
 *
 * The caller names which causes it may end: an explicit user resume and
 * automatic quota recovery both end a `user-stop` and a `turn-final-failure`
 * pause. The pause is compared against the exact token read here
 * so a newer pause is never cleared by accident, and every other Queue gate
 * (questionnaire, permission, dependencies) stays in force. Ending a failure
 * pause does not replay the failed Turn. Resolves whether a pause was ended.
 */
export function createStoppedQueueContinuation(queue) {
    return async (sessionId, causes) => {
        const committed = queue();
        if (!committed)
            return false;
        const pause = (await committed.snapshot(sessionId)).pause;
        const cause = causes.find((candidate) => candidate === pause?.cause);
        if (!pause || !cause)
            return false;
        await committed.continueQueue(sessionId, {
            cause,
            triggerTurnId: pause.triggerTurnId,
            pausedAtMs: pause.pausedAtMs,
        });
        return true;
    };
}
/**
 * End the `turn-final-failure` pause that this one failed Turn left, when the
 * caller finds what it is waiting for among the queued items.
 *
 * The pause must name exactly the failed Turn: a pause some later Turn left,
 * or a `user-stop` one, is never ended here. The exact token read here guards
 * the write, so a pause replaced in the meantime survives. Only the pause
 * ends: FIFO order and every other Queue gate stay as they are, and the failed
 * Turn is not replayed. Resolves whether the pause was ended.
 */
export function createFailedTurnPauseRelease(queue) {
    return async ({ sessionId, turnId, awaited }) => {
        const committed = queue();
        if (!committed)
            return false;
        const pause = (await committed.snapshot(sessionId)).pause;
        if (pause?.cause !== 'turn-final-failure' || pause.triggerTurnId !== turnId)
            return false;
        if (!awaited(await committed.list(sessionId)))
            return false;
        await committed.continueQueue(sessionId, {
            cause: 'turn-final-failure',
            triggerTurnId: pause.triggerTurnId,
            pausedAtMs: pause.pausedAtMs,
        });
        return true;
    };
}
//# sourceMappingURL=stopped-queue.js.map