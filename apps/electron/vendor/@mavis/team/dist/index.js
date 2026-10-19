/**
 * `@mavis/team` — produce-verify cycle engine for multi-agent plan execution.
 *
 * Pure-logic copy of daemon's `packages/daemon/src/team/`, adapted to use
 * structural ports (defined in `host-ports.ts`) and team-owned host-utils
 * helpers (`logger`, `getMetricsReporter`, `backgroundCtx`, `AppError`, etc.).
 * Hosts wire concrete implementations through {@link configureTeamHost}.
 *
 * Daemon today injects file-system backed implementations (filesystem
 * `PlanStore`, real `SessionService`, etc.). Cloud-runtime can wire HTTP /
 * remote-API implementations of the same ports without changing any code
 * inside agent-core.
 */
// ── Public engine surface ───────────────────────────────────────────
export { CycleEngine } from './engine.js';
export { PlanGc } from './gc.js';
export { EngineSessionManager, DEFAULT_END_EVENT_GRACE_MS, } from './engine-session.js';
export { EngineReporting, } from './engine-reporting.js';
export { EngineMessenger, createEngineMessenger, sendError, sendFailed, } from './engine-communication.js';
export { runProductionPhase, MAX_TASK_RUNTIME_MS, STATUS_SYNC_INTERVAL_MS, HEARTBEAT_SUMMARY_DEPTH, HEARTBEAT_SCAN_LIMIT, MAX_NO_DELIVERABLE_RETRIES, DELIVERABLE_WATCH_INTERVAL_MS, DELIVERABLE_STABLE_SAMPLES_REQUIRED, } from './engine-production.js';
export { runVerificationPhase, runVerifiersInParallel, } from './engine-verification.js';
export { BoardWatcher, parseBoardEntries, BOARD_POLL_INTERVAL_MS, BOARD_AGGREGATION_INTERVAL_MS, MAX_NUDGE_COUNT, ACTIVITY_RECENCY_THRESHOLD_MS, BOARD_STALE_THRESHOLD_MS, } from './board-watcher.js';
export { NudgeRegistry } from './nudge-registry.js';
export { collectFloorViolations, isVerifySkippedTaskAutoContinuable, validatePlanFloor, FloorValidationError, } from './engine-floor-validator.js';
// ── Pure helpers ────────────────────────────────────────────────────
export { buildTaskPrompt, buildVerificationPrompt, parseVerifierVerdict, formatCycleReport, } from './prompt-builder.js';
export { extractJsonFromText, parseStructuredResponse, parseVerifierResponse, buildRetryPrompt, VerifierVerdictSchema, } from './structured-response.js';
export { PlanSchema, PlanTaskSchema, PlanStateSchema, PlanStatusEnum, DecisionSchema, 
/** @deprecated Use DecisionSchema instead. */
PMDecisionSchema, TaskStatusEnum, CyclePhaseEnum, TaskOutputSchema, ObjectiveGateSchema, VerifierResultSchema, TaskResultSchema, TERMINAL_PLAN_STATUSES, VALID_TASK_TRANSITIONS, assertValidTaskTransition, } from './types.js';
// ── Host wiring ─────────────────────────────────────────────────────
export { configureTeamHost, resetTeamHostForTesting, getPlanStore, getSessionLifecycle, getSessionBridge, getCommunicationManager, getAgentManager, logger, backgroundCtx, AppError, getMetricsReporter, nowMs, formatLocalDateTime, } from './host-utils.js';
//# sourceMappingURL=index.js.map