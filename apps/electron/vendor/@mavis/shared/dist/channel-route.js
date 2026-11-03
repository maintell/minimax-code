/**
 * Channel Route Mapping types.
 *
 * Defines the data model for configurable channel/user → Agent/Session routing.
 * Route rules are stored in <dataDir>/channel-routes.yaml.
 */
/** Normalize a SessionStrategy: legacy 'main' → 'root'. */
export function normalizeSessionStrategy(strategy) {
    return strategy === 'main' ? 'root' : strategy;
}
/**
 * Steering producer id for an IM follow-up merged into the running Turn of the
 * same IM chat (desktop follow-up preference "send now"). Single definition:
 * the Channel System steers with it and the Turn System lists it as a
 * teardown-durable machine producer, so a merged follow-up acknowledged to IM
 * survives Stop / shutdown / lease loss instead of being dropped.
 */
export const CHANNEL_STEER_PRODUCER_ID = 'channel-steer';
/** Keep every legacy Root-shaped intent readable while making v2 Rootless. */
export function channelRoutingModeForStrategy(strategy) {
    switch (strategy) {
        case 'per-sender':
        case 'per-chat':
        case 'shared-task':
            return strategy;
        case 'root':
        case 'main':
        case 'pin':
            return 'project-main';
    }
}
//# sourceMappingURL=channel-route.js.map