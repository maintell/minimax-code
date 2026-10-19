import { requiredString } from './im-connection-store-data.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
/**
 * One-version startup migration: reads legacy route rows but never mutates
 * them. Invalid or ambiguous legacy rows stay readable through the old route
 * fallback and cannot stop unrelated platform restoration.
 */
export async function migrateLegacyImConnections(input) {
    const report = (code, keys, detail) => {
        if (keys.length > 0)
            input.onSkipped?.({ code, keys: [...new Set(keys)].sort(), ...detail });
    };
    const normalized = await collectMigratableRoutes(input, report);
    const groups = new Map();
    for (const route of normalized) {
        const key = `${route.agentName}\u0000${route.platform}`;
        const bucket = groups.get(key) ?? [];
        bucket.push(route);
        groups.set(key, bucket);
    }
    const plans = [];
    for (const routes of groups.values()) {
        const plan = await planGroupMigration(input, routes, report);
        if (plan)
            plans.push(plan);
    }
    // Deliberately NO cross-channel cursor check here. Uniqueness is scoped to
    // Agent+Project+CHANNEL (product decision 2026-09-18): every channel's
    // physical Binding owns its cursor independently, so telegram→SessionA and
    // feishu→SessionB for the same Agent+Project are both preserved. The old
    // `agentName+projectKey` plan comparison was a relic of the shared
    // single-Conversation-cursor model and, combined with "preserve the
    // historical Session", mass-skipped perfectly healthy channels.
    for (const plan of plans) {
        await materializeMigrationPlan(input, plan, report);
    }
}
/** Phase 1: drop replayed/invalid/superseded rows, normalize the rest. */
async function collectMigratableRoutes(input, report) {
    const normalized = [];
    for (const route of input.legacyRoutes) {
        const rawKey = typeof route.key === 'string' ? route.key.trim() : '';
        if (rawKey && input.preSkippedRouteKeys?.has(rawKey)) {
            report('CHANNEL_IM_LEGACY_ROUTE_RECEIPT_REPLAY', [rawKey]);
            continue;
        }
        let normalizedRoute;
        try {
            normalizedRoute = normalizeRoute(route);
        }
        catch (error) {
            if (error instanceof LocalImConnectionError) {
                report('CHANNEL_IM_LEGACY_ROUTE_INVALID', rawKey ? [rawKey] : []);
                continue;
            }
            throw error;
        }
        // Do not fold host/state reads into the malformed-row catch above: a
        // storage or runtime-port failure remains a startup failure, not a row
        // that can be silently ignored.
        const skip = await input.shouldSkipRoute?.(normalizedRoute);
        if (skip) {
            report(skip, [normalizedRoute.key]);
            continue;
        }
        normalized.push(normalizedRoute);
    }
    return normalized;
}
/** Phase 2: per Agent+Channel group, arbitrate conflicts and pick the survivor. */
async function planGroupMigration(input, routes, report) {
    const usable = [];
    for (const route of routes) {
        if (route.emptyCursor ||
            (await input.isUsableSession({
                agentName: route.agentName,
                projectKey: route.projectKey,
                sessionId: route.sessionId,
            }))) {
            usable.push(route);
        }
        else {
            // Keep the original opaque row, but do not let an obsolete cursor or
            // owner poison a healthy route in the same historical profile.
            report('CHANNEL_IM_LEGACY_ROUTE_INVALID', [route.key]);
        }
    }
    if (usable.length === 0)
        return undefined;
    const candidates = await arbitrateClientConflict(input, usable, report);
    if (!candidates || candidates.length === 0)
        return undefined;
    const keys = candidates.map((route) => route.key);
    if (new Set(candidates.map((route) => route.projectKey)).size > 1) {
        // A Project split is not a bot ambiguity: the credential store cannot
        // arbitrate it, so it remains a whole-group conflict.
        report('CHANNEL_IM_LEGACY_ROUTE_GROUP_CONFLICT', keys);
        return undefined;
    }
    // Merge rule (product decision 2026-09-18): rows disagreeing on their
    // Session are no longer a conflict — the group resolves to "the client's
    // current freshest root binding": rows with a root/main strategy (the
    // channel's historical primary binding) win over per-chat rows, freshest
    // `updatedAt` wins inside a tier, and the key order is only a final
    // stability tiebreak. An emptyCursor row keeps its priority — primary
    // identity outranks whether its Session survived; a chosen row whose
    // Session is gone simply materializes through the existing lazy
    // empty-cursor path.
    const strategyRank = (route) => isLegacyRootStrategy(route.strategy) ? 0 : 1;
    const chosen = candidates.sort((left, right) => strategyRank(left) - strategyRank(right) ||
        right.updatedAt - left.updatedAt ||
        left.key.localeCompare(right.key))[0];
    if (!chosen)
        return undefined;
    return {
        route: chosen,
        migratedLegacyRouteKeys: candidates
            .filter((route) => route.emptyCursor || route.sessionId === chosen.sessionId)
            .map((route) => route.key)
            .sort((left, right) => left.localeCompare(right)),
    };
}
/**
 * F4 (product decision 2026-09-18): one Agent runs at most ONE bot per
 * channel — the per-agent credential store is the single source of truth. A
 * same-profile client conflict is therefore arbitrated against the currently
 * active credential instead of skipping the whole group: rows of a superseded
 * bot stay opaque in legacy storage (reported per row), rows matching the
 * active client migrate normally. Returns undefined when the whole group must
 * be skipped.
 */
async function arbitrateClientConflict(input, usable, report) {
    if (new Set(usable.map((route) => route.clientName)).size <= 1)
        return usable;
    const groupKeys = usable.map((route) => route.key);
    const [profile] = usable;
    if (!profile)
        return undefined;
    if (!input.resolveActiveClient) {
        // No credential authority wired: keep the historical whole-group
        // skip so older callers observe unchanged behaviour.
        report('CHANNEL_IM_LEGACY_ROUTE_GROUP_CONFLICT', groupKeys);
        return undefined;
    }
    const activeClientName = (await input.resolveActiveClient({
        agentName: profile.agentName,
        channel: profile.platform,
    }))?.trim();
    if (!activeClientName) {
        // Without an active credential the transport cannot start anyway and
        // there is no fact to arbitrate with — keep the whole-group skip,
        // with a distinguishable reason.
        report('CHANNEL_IM_LEGACY_ROUTE_GROUP_CONFLICT', groupKeys, {
            reason: 'no_active_credential',
        });
        return undefined;
    }
    const superseded = usable.filter((route) => route.clientName !== activeClientName);
    if (superseded.length > 0) {
        report('CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED', superseded.map((route) => route.key), { reason: 'superseded_by_active_credential', activeClientName });
    }
    // Every row may belong to an old bot; the conflict is then fully
    // arbitrated with no survivor to materialize.
    return usable.filter((route) => route.clientName === activeClientName);
}
/** Phase 3: prepare/bind the surviving route; superseded errors degrade to a skip. */
async function materializeMigrationPlan(input, plan, report) {
    const { route, migratedLegacyRouteKeys } = plan;
    try {
        const connection = (await input.findConnection(route.agentName, route.platform)) ??
            (await input.prepareConnection({
                agentName: route.agentName,
                channel: route.platform,
                projectKey: route.projectKey === 'default' ? null : route.projectKey,
                resolvedProjectKey: route.projectKey,
                pendingLegacyRouteKeys: migratedLegacyRouteKeys,
            }));
        await input.bindConnection({
            connectionId: connection.connectionId,
            clientName: route.clientName,
            ...(route.emptyCursor ? { emptyCursor: true } : { currentSessionId: route.sessionId }),
            migratedLegacyRouteKeys,
            migration: true,
        });
    }
    catch (error) {
        if (isSupersededMigrationError(error)) {
            report('CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED', migratedLegacyRouteKeys);
            return;
        }
        throw error;
    }
}
/** Mirrors the private helpers beside the other legacy-route consumers. */
function isLegacyRootStrategy(strategy) {
    return strategy === 'root' || strategy === 'main';
}
function normalizeRoute(route) {
    const key = requiredString(route.key, 'legacy route key');
    const emptyCursor = route.emptyCursor === true;
    const sessionId = emptyCursor
        ? String(route.sessionId ?? '').trim()
        : requiredString(route.sessionId, 'legacy sessionId');
    if (emptyCursor && sessionId) {
        throw new LocalImConnectionError(400, 'CHANNEL_CONNECTION_MIGRATION_INVALID', 'An empty legacy cursor cannot carry a Session.');
    }
    return {
        ...route,
        key,
        platform: normalizeLegacyChannel(route.platform),
        clientName: requiredString(route.clientName, 'legacy clientName'),
        agentName: requiredString(route.agentName, 'legacy agentName'),
        projectKey: requiredString(route.projectKey, 'legacy projectKey'),
        sessionId,
        ...(emptyCursor ? { emptyCursor: true } : {}),
    };
}
function normalizeLegacyChannel(value) {
    if (value === 'lark')
        return 'feishu';
    if (value === 'feishu' || value === 'telegram' || value === 'wechat')
        return value;
    throw new LocalImConnectionError(400, 'CHANNEL_CONNECTION_MIGRATION_INVALID', 'Legacy Channel route has an unsupported channel.');
}
function isSupersededMigrationError(error) {
    if (!(error instanceof LocalImConnectionError))
        return false;
    return (error.code === 'CHANNEL_CONNECTION_MIGRATION_CONFLICT' ||
        error.code === 'CHANNEL_CONNECTION_ALREADY_BOUND' ||
        error.code === 'CHANNEL_EXTERNAL_ALREADY_BOUND' ||
        error.code === 'CHANNEL_CONNECTION_BOUND_IMMUTABLE' ||
        error.code === 'CHANNEL_CONNECTION_DUPLICATE');
}
//# sourceMappingURL=im-connection-store-migration.js.map