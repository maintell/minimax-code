/**
 * Stable Session Clio Query identities.
 *
 * A Query is admitted at its real submission and bound to a Turn later, so both
 * moments must derive the same id from data that already survives a restart.
 * These live apart from the capture so producers can mint an id without
 * depending on capture internals.
 */
/** Direct submit: the requested or accepted Turn id identifies its Query, even if submission fails. */
export function sessionClioDirectQueryId(turnId) {
    return `q:turn:${turnId}`;
}
/** Queued submit: the durable queue item outlives the dispatch that consumes it. */
export function sessionClioQueuedQueryId(itemId) {
    return `q:item:${itemId}`;
}
/** Steering: the producer's own idempotency identity, which survives restore and replay. */
export function sessionClioSteeringQueryId(message) {
    return `q:steer:${message.producerId}:${message.idempotencyKey}`;
}
//# sourceMappingURL=query-identity.js.map