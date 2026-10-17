/** Producers whose steering is user-visible work rather than machine delivery. */
const USER_STEERING_PRODUCERS = new Set([
    'queue-immediate-send',
    'composer-steer',
    'paused-queue-composer',
]);
/**
 * User steering never extends a finished answer and must survive Turn
 * teardown: the executor defers it at the exit boundary and discard paths
 * requeue it as a fresh query. Non-user producers keep inject/drop semantics.
 */
export function isUserSteeringProducer(producerId) {
    return USER_STEERING_PRODUCERS.has(producerId);
}
//# sourceMappingURL=contracts.js.map