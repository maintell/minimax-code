/**
 * Team subsystem host ports — structural interfaces consumed by the team
 * orchestration code in @mavis/team (`CycleEngine`, `PlanStore`,
 * `BoardWatcher`, `EngineProduction/Verification/Reporting/Session`,
 * `PlanGc`).
 *
 * Daemon's concrete classes (`PlanStore` (file-system), `AgentManager`,
 * `SessionService`, `SessionBridge`, `CommunicationManager`,
 * `MultiChannelClient`, `MessageQueue`) satisfy these interfaces by shape;
 * no `implements` declaration required. The ports below name only the
 * methods the agent-core team orchestrator actually invokes — adding new
 * features should grow the port deliberately.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalDateTime`) are team-owned collaborators
 * configured through `configureTeamHost`; this file only declares
 * team-specific ports.
 */
export {};
//# sourceMappingURL=host-ports.js.map