/**
 * No-IM-capability channel port (IM MR3).
 *
 * Bound by `internal` composition hosts (embedded CLI/TUI, standalone v1)
 * after the v1 package stopped containing an IM implementation. Semantics
 * mirror an EMPTY subsystem, not a broken one:
 *
 * - Ambient touchpoints that fire during normal non-IM operation (session
 *   cleanup, permission fan-out, questionnaire delivery, the cron config
 *   gate) return the same results an assembled subsystem with zero bindings
 *   and zero live clients produced — so non-IM functionality is unaffected.
 * - IM-only delivery touchpoints (`sendChannelText`,
 *   `deliverReplyFromMessages`) fail loudly with the EXISTING stable
 *   `CHANNEL_CLIENT_UNAVAILABLE` contract (the same code a live subsystem
 *   raises when no client is registered for a context) — never a silent
 *   drop of a user-visible reply.
 * - Agent IM routes are unreachable on these hosts (the host's channel
 *   capability gate answers them with the legacy 404 first); reaching them
 *   through the port anyway is a mis-assembly and throws.
 * - Lifecycle is a no-op: these hosts must never start transports.
 */
import { logger } from '../common/logger.js';
import { CHANNEL_CLIENT_UNAVAILABLE, LocalChannelClientUnavailableError, } from './host-channel-port.js';
/** Loud contract for IM-only touchpoints on a no-IM host. */
function unsupported(capability) {
    return new Error(`ASSEMBLY_ERROR: the channel subsystem has no IM capability on this host (needed for ${capability}; mode=internal)`);
}
export function buildNoChannelCapabilityPort(input) {
    const agentName = input.agentName;
    return {
        // Session cleanup: an empty subsystem has no bindings.
        listBindingSessionIds: async () => [],
        deleteBindingsBySession: async (sessionId) => {
            logger.info({ sessionId, agentName, mode: 'no-im' }, 'Channel binding cleanup skipped: host has no IM capability');
            return 0;
        },
        // Permission fan-out: with zero channel conversations there is nobody to
        // notify; identical to the empty permission bridge before MR3.
        permissionOutbound: {
            onPermissionAsk: async () => {
                // Intentionally silent: fires on EVERY permission ask.
            },
        },
        forgetPermissionSession: () => { },
        deliverReplyFromMessages: async ({ ctx, sessionId }) => {
            // A channel-context turn cannot originate on a no-IM host; if channel
            // data leaked in from a shared profile, fail with the stable code
            // instead of silently dropping a terminal reply.
            logger.error({ sessionId, platform: ctx.platform, mode: 'no-im' }, 'Channel reply delivery rejected: host has no IM capability');
            throw new LocalChannelClientUnavailableError({
                platform: String(ctx.platform ?? 'unknown'),
                clientName: 'no-im-host',
            });
        },
        // Typing indicators are best-effort even on live subsystems (no adapter
        // registered → return); a no-IM host has no adapters by definition.
        notifyTurnStart: async () => { },
        notifyTurnEnd: async () => { },
        // Documented 'unavailable' contract: the caller records metrics/bus
        // events, exactly like an assembled subsystem without a capable client.
        sendQuestionnaireMessage: async ({ sessionId }) => {
            logger.warn({ sessionId, agentName, mode: 'no-im' }, 'Questionnaire IM delivery unavailable: host has no IM capability');
            return 'unavailable';
        },
        sendChannelText: async ({ ctx }) => {
            // The cron delivery port gates on isChannelConfigured() first, so this
            // only fires on a race/misuse; keep the stable no-client contract.
            logger.error({ platform: ctx.platform, clientName: ctx.clientName, mode: 'no-im' }, `Channel text delivery rejected (${CHANNEL_CLIENT_UNAVAILABLE}): host has no IM capability`);
            throw new LocalChannelClientUnavailableError({
                platform: ctx.platform,
                clientName: ctx.clientName,
            });
        },
        // Cron gate: nothing is ever configured on a no-IM host, so cron channel
        // delivery is skipped upstream (existing skip path, no new error).
        isChannelConfigured: async () => false,
        routeAgentIm: async (routedAgentName) => {
            // Unreachable: channelCapabilityEnabled=false keeps agent IM routes on
            // the legacy 404 before the port is consulted.
            throw unsupported(`agent IM routes (${routedAgentName})`);
        },
        buildAgentChannelConfig: async () => undefined,
        startChannelSubsystem: async () => {
            logger.info({ agentName, mode: 'no-im' }, 'Channel startup skipped: internal composition has no IM capability (MR3)');
        },
        shutdownChannelSubsystem: async () => { },
    };
}
//# sourceMappingURL=host-channel-unsupported-port.js.map