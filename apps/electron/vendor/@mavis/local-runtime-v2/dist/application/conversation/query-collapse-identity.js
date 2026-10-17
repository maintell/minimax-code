const STEERING_QUERY_MARKER = ':s:';
export function queryCollapseQueryKey(turnId, goalId) {
    return goalId ? `goal:${goalId}:turn:${turnId}` : `turn:${turnId}`;
}
/**
 * Derives the explicit steered fields for one query key at projection time.
 * Old rows persisted with only a marked key project the same fields, so no
 * migration is needed and consumers never parse the marker themselves.
 */
export function queryCollapseSteeringProjection(queryKey) {
    if (!queryKey)
        return {};
    const rootQueryKey = queryCollapseRootQueryKey(queryKey);
    return rootQueryKey === queryKey ? {} : { steered: true, root_query_key: rootQueryKey };
}
function queryCollapseRootQueryKey(queryKey) {
    const markerIndex = queryKey.indexOf(STEERING_QUERY_MARKER);
    return markerIndex < 0 ? queryKey : queryKey.slice(0, markerIndex);
}
/** Resolves one stable display identity before a Turn enters execution. */
export function createQueryCollapseKeyResolver(options) {
    return {
        queryKeyForTurn: (sessionId, turnId) => resolveNewQueryKey(options, sessionId, turnId),
        queryKeyForContinuation: async (sessionId, turnId) => {
            const priorQueryKey = await latestVisibleQueryKey(options, sessionId);
            if (priorQueryKey) {
                try {
                    const persisted = await options.state.findByKey(sessionId, priorQueryKey);
                    if (persisted)
                        return persisted.queryKey;
                }
                catch {
                    // A missing display projection falls back to the deterministic Turn identity.
                }
            }
            return resolveNewQueryKey(options, sessionId, turnId);
        },
    };
}
async function resolveNewQueryKey(options, sessionId, turnId) {
    try {
        const existing = await options.state.findByCurrentTurn(sessionId, turnId);
        if (existing)
            return existing.queryKey;
    }
    catch {
        // Identity remains derivable when the optional sidecar is unavailable.
    }
    if (!options.getGoalBySession)
        return queryCollapseQueryKey(turnId);
    try {
        const goal = await options.getGoalBySession(sessionId);
        return queryCollapseQueryKey(turnId, goal?.status === 'complete' ? undefined : goal?.goalId);
    }
    catch {
        return queryCollapseQueryKey(turnId);
    }
}
async function latestVisibleQueryKey(options, sessionId) {
    if (!options.messages)
        return undefined;
    try {
        const messages = await options.messages.listRecent(sessionId, { limit: 1, role: 'user' });
        const queryKey = messages[0]?.query_key;
        return typeof queryKey === 'string' && queryKey.length > 0 ? queryKey : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=query-collapse-identity.js.map