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