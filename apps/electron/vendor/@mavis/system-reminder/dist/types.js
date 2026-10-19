/**
 * System-reminder types — shared across all framework adapters.
 *
 * Migrated from legacy prompt transform to enable
 * framework-agnostic system-reminder injection at the SessionBridge level.
 *
 * Configuration is keyed by AgentFrameworkType so each framework can have
 * independent reminder schedules (e.g. "first message only" vs "every 5 messages").
 */
// ─── Session / Message contracts (self-owned) ────────────────────────────────
//
// These enums and the narrow SessionInfo / MessageRequest shapes are owned by
// this package. They were originally defined here, briefly lived under the
// agent-core host layer, and are kept self-contained again so system-reminder
// never imports a runtime host package. The agent-core host layer keeps its
// own independent copies for its orchestration consumers; the two are
// deliberately decoupled (structural compatibility is all the cloud shim
// needs).
/**
 * Session role in the agent's session tree.
 *
 * - Branch: a task-scoped child session (has a parent).
 * - Root:   the long-lived front-door session for the agent.
 *
 * Numeric values are stable forever (persisted in `sessions.session_type`).
 */
export var SessionType;
(function (SessionType) {
    SessionType[SessionType["Branch"] = 0] = "Branch";
    SessionType[SessionType["Root"] = 1] = "Root";
})(SessionType || (SessionType = {}));
/**
 * Channel role for messages flowing through the runtime — the user-vs-agent
 * distinction. Distinct from the protocol-level speaker role (`user`/`assistant`).
 */
export var Role;
(function (Role) {
    Role["User"] = "user";
    Role["Agent"] = "agent";
})(Role || (Role = {}));
/** Worker vs orchestrator agent classification. */
export var AgentRole;
(function (AgentRole) {
    AgentRole[AgentRole["Worker"] = 0] = "Worker";
    AgentRole[AgentRole["Orchestrator"] = 1] = "Orchestrator";
})(AgentRole || (AgentRole = {}));
/** Underlying agent framework. */
export var AgentFrameworkType;
(function (AgentFrameworkType) {
    /** @deprecated Legacy opencode sessions are only resumable through the legacy boundary. */
    AgentFrameworkType["OpenCode"] = "opencode";
    AgentFrameworkType["PiAgent"] = "pi-agent";
    AgentFrameworkType["Codex"] = "codex";
})(AgentFrameworkType || (AgentFrameworkType = {}));
// ─── Evolution Config ────────────────────────────────────────────────────────
export const EVOLUTION_CONFIG = {
    /** First memory-write reminder fires after this many turns. */
    MEMORY_REMINDER_INITIAL_INTERVAL: 10,
    /** Max interval after exponential back-off (caps doubling). */
    MEMORY_REMINDER_MAX_INTERVAL: 40,
    /**
     * @deprecated v3: skill-crystallization in-turn reminder removed —
     * skill reflection now happens at session end via the daily-digest
     * fallback re-prompt. Constants kept for back-compat with any external
     * imports / tests; not read by `getEvolutionReminder` anymore.
     */
    SKILL_REMINDER_THRESHOLD: 5,
    /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
    SKILL_REMINDER_INITIAL_INTERVAL: 10,
    /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
    SKILL_REMINDER_MAX_INTERVAL: 40,
    /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
    SKILL_REMINDER_INTERVAL: 20,
};
//# sourceMappingURL=types.js.map