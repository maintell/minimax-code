/**
 * Replay checks for IM follow-ups. An IM platform may redeliver an event after
 * the IM dedup window; these read-only checks keep such a replay from being
 * delivered to the Session a second time.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { describeFollowError, } from './channel-follow-contracts.js';
/**
 * A merged IM event leaves only a steer receipt, which neither the submit nor
 * the queue deduplication reads. A replay after the IM dedup window would run
 * again once that Turn ended or the preference went back to queue, so this
 * check runs first, before the preference, on every path. Read-only; any
 * failure continues with the normal routing (the queue dedup still applies).
 */
export async function findMergedEventTurn(deps, clientRequestId, decision) {
    if (!clientRequestId) {
        // Without an event identity there is nothing to match a replay against.
        decision.mergedCheck = 'skipped_no_request_id';
        return undefined;
    }
    if (!deps.findMergedChannelEvent) {
        logger.warn({ sessionId: decision.sessionId, platform: decision.platform }, 'IM follow-up merged-event lookup is not bound; continuing without it');
        decision.mergedCheck = 'unavailable';
        return undefined;
    }
    try {
        const turnId = await deps.findMergedChannelEvent(decision.sessionId, clientRequestId);
        // A miss is the common case: a new event, routed normally below.
        decision.mergedCheck = turnId ? 'hit' : 'miss';
        return turnId;
    }
    catch (error) {
        logger.warn({
            sessionId: decision.sessionId,
            platform: decision.platform,
            error: describeFollowError(error),
        }, 'IM follow-up merged-event lookup failed; continuing without it');
        decision.mergedCheck = 'failed';
        return undefined;
    }
}
/**
 * An IM event replayed after the IM dedup window may already sit in this
 * Session through the queue path. The steer receipt lives under its own key,
 * so the steer would not notice and would deliver the content a second time.
 * Both checks are read-only; without a request id there is nothing to match.
 * `steer` is the busy-route candidate: the active Turn and its steer plan.
 */
export async function checkReplayBeforeSteer(deps, input, steer, decision) {
    const { active, plan } = steer;
    const clientRequestId = input.submit.clientRequestId;
    if (!clientRequestId)
        return plan;
    if (active.clientRequestTurnId) {
        // A Turn was admitted with this request id: the replay of the message
        // that started it (or an earlier one); the event is already handled.
        decision.reason = 'replay_turn';
        return { route: 'duplicate', turnId: active.clientRequestTurnId };
    }
    try {
        const queued = await deps.ingress.findQueuedByClientRequestId(input.submit.sessionId, clientRequestId);
        if (!queued)
            return plan;
        // Still queued, or claimed and about to run: it will be answered anyway.
        decision.reason = 'replay_queued';
        return { route: 'duplicate' };
    }
    catch (error) {
        // A replay cannot be ruled out, but the queue path deduplicates by request
        // id itself, so it is the safe fallback.
        logger.warn({
            sessionId: decision.sessionId,
            platform: decision.platform,
            error: describeFollowError(error),
        }, 'IM follow-up replay check failed; falling back to queue');
        decision.reason = 'replay_check_failed';
        return { route: 'submit' };
    }
}
//# sourceMappingURL=channel-follow-replay.js.map