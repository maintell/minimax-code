/**
 * Cron subsystem host ports — structural interfaces consumed by
 * `CronExecutor` and `CronRegistry`.
 *
 * Daemon's concrete classes (`CronStore`, `SessionService`, `AgentManager`,
 * `MultiChannelClient`, `MessageQueue`) satisfy these interfaces by shape;
 * no `implements` declaration required. The ports below name only the
 * methods the agent-core cron orchestrator actually invokes — adding new
 * features should grow the port deliberately.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalMonthDayTime`) are configured through
 * `configureCronHost`; this file only declares cron-specific ports.
 */
// ─── Session bridge / event bus ports ────────────────────────────────────
export const Role = {
    User: 'user',
    Agent: 'agent',
};
/**
 * Lane name used by cron-triggered sends. Mirrors
 * `daemon/src/channel-bridge/message-queue.ts:MessageLaneName.Cron`.
 */
export const CRON_MESSAGE_LANE = 'cron';
//# sourceMappingURL=host-ports.js.map