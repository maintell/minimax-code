/**
 * System-reminder collaborator registry.
 *
 * The system-reminder subsystem consumes its cross-cutting runtime
 * collaborators (logger, request context, config, date formatting) through
 * constructor injection on `SystemReminderService`. The SR-specific
 * collaborator `NudgeRegistry` flows through constructor injection on
 * `createBoardNudgeProvider`.
 *
 * This module exposes `configureSystemReminderHost` as a thin marker /
 * future-extension point so the host declares subsystem wiring symmetrically
 * with the other agent-module subsystems. Currently the only side effect is to
 * record the host-side defaults so tests that construct an SR service ad-hoc
 * can reuse them. Constructor / setter injection on the service stays the
 * primary path — these module-scope defaults are a convenience only.
 */
let _defaultNudgeRegistry = null;
/**
 * Register optional system-reminder defaults. Idempotent — later calls
 * overwrite the recorded references; missing fields preserve previous
 * registrations.
 */
export function configureSystemReminderHost(opts) {
    if (opts.nudgeRegistry !== undefined)
        _defaultNudgeRegistry = opts.nudgeRegistry;
}
/** Returns the registered default `NudgeRegistry`, or null if none. */
export function getDefaultNudgeRegistry() {
    return _defaultNudgeRegistry;
}
/** Test helper — clear all registered defaults. */
export function _resetSystemReminderHostForTests() {
    _defaultNudgeRegistry = null;
}
//# sourceMappingURL=collaborators.js.map