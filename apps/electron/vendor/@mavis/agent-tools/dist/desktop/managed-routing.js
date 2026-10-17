const LANE_PATTERN = /^[A-Za-z0-9._-]+$/u;
export function normalizeManagedBackendRoutingContext(value, buildEnv) {
    if (buildEnv !== 'dev' && buildEnv !== 'test' && buildEnv !== 'staging')
        return undefined;
    const lane = typeof value === 'string' ? value.trim() : '';
    return lane && LANE_PATTERN.test(lane) ? { bedrockLane: lane } : undefined;
}
export function managedBackendRoutingHeaders(context, buildEnv) {
    if (buildEnv !== 'dev' && buildEnv !== 'test' && buildEnv !== 'staging')
        return {};
    const lane = context?.bedrockLane?.trim();
    return lane && LANE_PATTERN.test(lane) ? { 'bedrock-lane': lane, bedrock_lane: lane } : {};
}
//# sourceMappingURL=managed-routing.js.map