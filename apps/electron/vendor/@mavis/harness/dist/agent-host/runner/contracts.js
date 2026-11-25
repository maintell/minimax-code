import { CHANNEL_STEER_PRODUCER_ID } from '@mavis/shared';
import { QUESTIONNAIRE_ANSWER_STEERING_PRODUCER } from '@mavis/shared/questionnaire';
/** Producers whose steering is user-visible work rather than machine delivery. */
const USER_STEERING_PRODUCERS = new Set([
    'queue-immediate-send',
    'composer-steer',
    'paused-queue-composer',
    'miniapp-steer',
]);
/**
 * User steering from hosts that have no lane to requeue it as a fresh query:
 * what a user types into the MCode TUI or an ACP client while a Turn runs
 * (`mcode`, `mcode-acp`), and what the cloud harness server receives through
 * SteerRun (`cloud-steer`; archon-server completes the queued item when it
 * accepts the steer). The exit boundary injects it into the running Turn,
 * which keeps working on it. Only when a Turn's work is closed (a Goal Turn
 * whose request budget is spent) is it handed back to the session like other
 * user steering (Goal spec §5.5).
 */
const TERMINAL_USER_STEERING_PRODUCERS = new Set([
    'mcode',
    'mcode-acp',
    'cloud-steer',
]);
/**
 * User steering never extends a finished answer and must survive Turn
 * teardown: the executor defers it at the exit boundary and discard paths
 * requeue it as a fresh query. Non-user producers keep inject/drop semantics.
 */
export function isUserSteeringProducer(producerId) {
    return USER_STEERING_PRODUCERS.has(producerId);
}
/**
 * Machine producers whose steering carries input the user already gave and
 * was already acknowledged for: an AskUser v2 answer, and an IM follow-up
 * merged into the running IM Turn (`channel-steer`, receipted to IM as
 * received). They keep machine semantics while the Turn runs (still injected
 * at a normal exit boundary while work remains open), but teardown must
 * persist them like user steering instead of dropping them, or the input would
 * be lost after Stop / shutdown / lease loss.
 */
const TEARDOWN_DURABLE_MACHINE_PRODUCERS = new Set([
    QUESTIONNAIRE_ANSWER_STEERING_PRODUCER,
    CHANNEL_STEER_PRODUCER_ID,
]);
/**
 * Every session send carries this prefix, one producer per sending Session. The
 * sender was told its message arrived and that it may end its Turn, so nothing
 * would ever send it again: teardown has to keep it like any acknowledged input.
 */
const SESSION_SEND_STEERING_PRODUCER_PREFIX = 'session-send:';
function isTeardownDurableMachineProducer(producerId) {
    return (TEARDOWN_DURABLE_MACHINE_PRODUCERS.has(producerId) ||
        producerId.startsWith(SESSION_SEND_STEERING_PRODUCER_PREFIX));
}
export function isTeardownDurableSteeringProducer(producerId, workClosed = false) {
    return (isHandedBackOnClose(producerId, workClosed) || isTeardownDurableMachineProducer(producerId));
}
/**
 * A normal exit defers user input; closed work also defers terminal input,
 * pending answers and merged IM follow-ups (requeued with their IM origin).
 */
export function isHandedBackOnClose(producerId, workClosed) {
    return (isUserSteeringProducer(producerId) ||
        (workClosed &&
            (TERMINAL_USER_STEERING_PRODUCERS.has(producerId) ||
                isTeardownDurableMachineProducer(producerId))));
}
//# sourceMappingURL=contracts.js.map