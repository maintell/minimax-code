/**
 * Events fed into the Session Clio lifecycle reducer.
 *
 * Every event carries its own timestamp. The reducer has no clock, so a caller
 * that never sends `tick` will still seal correctly: the next real event's
 * timestamp is itself an expiry observation, checked before that event is
 * admitted or finalized.
 */
export {};
//# sourceMappingURL=events.js.map