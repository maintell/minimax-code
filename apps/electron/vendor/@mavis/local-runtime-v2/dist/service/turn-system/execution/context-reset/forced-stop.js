/**
 * @internal Exported only for focused tests.
 *
 * Abort reason of a Turn a context reset stops: like a user stop it ends the
 * Turn as stopped, but neither pauses the queue (context reset spec 3.3) nor
 * stops the Session's background work and task sessions (3.1).
 */
export const CONTEXT_RESET_ABORT_REASON = 'bunny_context_reset';
/**
 * Stops the running Turn as a user stop would, without its queue pause and
 * cascade (3.1). A Turn that does not release within the stop timeout is
 * ended by force: settled as stopped and its lock released, so the reset
 * can take the Session, while the Turn's later writes are dropped (3.2).
 */
export async function stopRunningTurn(options, sessionId) {
    const { controller } = options;
    const turnId = controller.activeTurnId(sessionId);
    if (!turnId)
        return { stopped: false, forced: false };
    const result = await controller.abort({ sessionId, turnId, reason: CONTEXT_RESET_ABORT_REASON });
    if (result.status !== 'abort-timeout')
        return { stopped: true, forced: false };
    const turn = controller.forceRelease?.(sessionId, turnId);
    if (!turn)
        return { stopped: true, forced: false };
    await settleForcedTurn(options, turn);
    return { stopped: true, forced: true };
}
async function settleForcedTurn(options, turn) {
    try {
        await options.failures.project({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            turnSequence: turn.acceptedSequence,
            eventId: `${turn.turnId}:force-released`,
            error: CONTEXT_RESET_ABORT_REASON,
            status: 'aborted',
        });
    }
    catch {
        // The Session state may already show a terminal; the lock release below still has to happen.
    }
    try {
        await options.repository.settle({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            leaseId: turn.leaseId,
            outcome: 'aborted',
        });
    }
    catch (error) {
        // The reset's admission then finds the Session busy and reports it.
        try {
            options.logger?.info({
                event: 'turn_force_release_settle_failed',
                session_id: turn.sessionId,
                turn_id: turn.turnId,
                error: error instanceof Error ? error.message : String(error),
            }, '[local-runtime-v2] Force-released Turn could not be settled');
        }
        catch {
            // Diagnostics never change the reset.
        }
    }
}
//# sourceMappingURL=forced-stop.js.map