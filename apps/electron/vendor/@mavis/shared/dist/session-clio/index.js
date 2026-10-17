/**
 * `@mavis/shared/session-clio` — the Session Clio v1 source lifecycle engine.
 *
 * A pure, JSON-serializable state machine shared by the desktop and cloud
 * runtimes. It owns capture identity, the 72h inactivity clock and sealing, and
 * it emits the exact wire steps to upload. It owns no transport, no database
 * and no timer: adapters persist the returned state and steps atomically, and
 * drive expiry by feeding events or ticks.
 */
export { resolveSessionClioCaptureEnabled } from './capture-config.js';
export { EvalCaptureOrigin, EvalQueryTrigger, EvalStepType, EvalTurnStatus } from './wire.js';
export { createSessionClioState, isSessionClioSealed, SESSION_CLIO_INACTIVITY_MS, SESSION_CLIO_INPUT_VERSION, SESSION_CLIO_SEQUENCE_BASE, sessionClioDeadlineMs, } from './state.js';
export { classifySessionClioSource } from './source-classifier.js';
export { applySessionClioEvent, SESSION_CLIO_ADMISSION_TURN_PREFIX, SessionClioContradictionError, } from './reducer.js';
//# sourceMappingURL=index.js.map