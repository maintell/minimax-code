/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-legacy-operations.ts`.
 */
import { mutateDurableYaml, readYamlDocument } from '../storage/durable-yaml.js';
import { findConnection, invalidImStorage, legacyImMigrationProfile, nextBindingUpdatedAt, readBindingData, readLegacyConversationById, writeBindingData, } from './im-connection-store-data.js';
import { assertImBindingRuntimeState, readImBindingState, } from './im-connection-store-operations.js';
import { migrateLegacyImConnections } from './im-connection-store-migration.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
export async function migrateImLegacyConnections(operations, input, delegates) {
    await migrateExistingImBindingConversationState(operations);
    await repairTrustedImLegacyRoutes(operations, input.legacyRoutes, input.onSkipped);
    const { bindingData, tombstones } = await readImBindingState(operations);
    const receivedRouteKeys = new Set([...bindingData.physicalBindings.values()].flatMap((binding) => binding.migratedLegacyRouteKeys ?? []));
    await migrateLegacyImConnections({
        legacyRoutes: input.legacyRoutes,
        preSkippedRouteKeys: receivedRouteKeys,
        isUsableSession: input.isUsableSession,
        shouldSkipRoute: async (route) => {
            const channel = legacyMigrationChannel(route.platform);
            if (tombstones.has(legacyImMigrationProfile(route.agentName, channel))) {
                return 'CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED';
            }
            const connection = findConnection(bindingData.connections, route.agentName, channel);
            const pendingExactRoute = connection?.pendingLegacyRouteKeys?.includes(route.key) === true;
            if (connection && !pendingExactRoute) {
                // A normal Connection (including an explicitly unbound one) is a
                // V2 user choice. A migration-created pending Connection is the one
                // recoverable exception, and only for its exact source row.
                return 'CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED';
            }
            // A write failure before the direct Binding commits leaves only the
            // exact pending receipt. Resume no other historical route.
            return undefined;
        },
        ...(input.onSkipped ? { onSkipped: input.onSkipped } : {}),
        ...(input.resolveActiveClient ? { resolveActiveClient: input.resolveActiveClient } : {}),
        findConnection: delegates.findConnection,
        prepareConnection: delegates.prepareConnection,
        bindConnection: (binding) => delegates.bindConnection({
            ...binding,
            expectedPendingLegacyRouteKeys: binding.migratedLegacyRouteKeys,
        }),
    });
    await revealTrustedImLegacyCredentialSessions(operations, input.legacyRoutes);
}
/**
 * Repair only a receipt-proven automatic `default` import, or a legacy
 * `root` / `main` receipt whose opaque cursor predates the Agent's current
 * Root. The source cursor, Project, receipt, and untouched V2 state must
 * agree before moving the Binding atomically with its Connection.
 */
async function repairTrustedImLegacyRoutes(operations, routes, onSkipped) {
    for (const route of routes) {
        await repairOneTrustedLegacyRoute(operations, route, onSkipped);
    }
}
function resolveTrustedRepairSource(route) {
    const trustedRootSessionId = route.trustedRootSessionId?.trim();
    const legacyRoot = readLegacyRootCursor(route, trustedRootSessionId);
    const sourceSessionId = legacyRoot?.sessionId ?? trustedRootSessionId;
    const sourceProjectKey = legacyRoot?.projectKey ?? 'default';
    if (!trustedRootSessionId ||
        !sourceSessionId ||
        route.emptyCursor ||
        (sourceSessionId === trustedRootSessionId && sourceProjectKey === route.projectKey)) {
        return undefined;
    }
    return {
        trustedRootSessionId,
        sourceSessionId,
        sourceProjectKey,
        repairsLegacyRootCursor: legacyRoot !== undefined,
    };
}
/** The stale root/main cursor this receipt may repair, when it diverged. */
function readLegacyRootCursor(route, trustedRootSessionId) {
    if (!isLegacyRootStrategy(route.strategy))
        return undefined;
    const sessionId = route.legacyRootSessionId?.trim();
    const projectKey = sessionId ? route.legacyRootProjectKey?.trim() : undefined;
    if (!sessionId || !projectKey)
        return undefined;
    const diverged = sessionId !== trustedRootSessionId || projectKey !== route.projectKey;
    return diverged ? { sessionId, projectKey } : undefined;
}
/** The Binding that adopted this exact legacy source row (receipt-proven). */
function findReceiptBinding(bindingData, channel, route) {
    return [...bindingData.physicalBindings.values()].find((candidate) => candidate.channel === channel &&
        candidate.clientName === route.clientName &&
        candidate.migratedLegacyRouteKeys?.includes(route.key));
}
async function repairOneTrustedLegacyRoute(operations, route, onSkipped) {
    const source = resolveTrustedRepairSource(route);
    if (!source)
        return;
    const channel = legacyMigrationChannel(route.platform);
    const { bindingData } = await readImBindingState(operations);
    const binding = findReceiptBinding(bindingData, channel, route);
    if (!binding)
        return;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection)
        throw invalidImStorage('physicalBindings', binding.bindingId);
    const state = assertImBindingRuntimeState(binding, connection);
    if (repairAlreadyConverged({ connection, state, route, channel, source })) {
        // This exact receipt already converged on a previous startup. Do not
        // emit a repair warning merely because its old cursor is now stale.
        return;
    }
    if (!snapshotMatchesProvenSource({ connection, state, route, channel, source, binding })) {
        onSkipped?.({ code: 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN', keys: [route.key] });
        return;
    }
    const outcome = await runTrustedRouteRepair(operations, {
        route,
        channel,
        source,
        connection,
        binding,
    });
    if (outcome !== 'repaired') {
        onSkipped?.({
            code: outcome === 'conflict'
                ? 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_CONFLICT'
                : 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN',
            keys: [route.key],
        });
    }
}
function repairAlreadyConverged(check) {
    const { connection, state, route, channel, source } = check;
    const targetProjectKey = route.projectKey === 'default' ? null : route.projectKey;
    return (connection.agentName === route.agentName &&
        connection.channel === channel &&
        connection.projectKey === targetProjectKey &&
        connection.resolvedProjectKey === route.projectKey &&
        state.resolvedProjectKey === route.projectKey &&
        state.currentSessionId === source.trustedRootSessionId);
}
function snapshotMatchesProvenSource(check) {
    const { connection, state, route, channel, source, binding } = check;
    if (!connectionOnProvenSource(connection, route, channel, source))
        return false;
    if (state.resolvedProjectKey !== source.sourceProjectKey ||
        state.currentSessionId !== source.sourceSessionId) {
        return false;
    }
    // A legacy-root cursor repair is only proven while both rows are pristine
    // (never updated since creation): any later write voids the evidence.
    return !(source.repairsLegacyRootCursor &&
        (connection.updatedAt !== connection.createdAt || binding.updatedAt !== binding.createdAt));
}
/** Connection identity/Project columns still describe the proven source row. */
function connectionOnProvenSource(connection, route, channel, source) {
    const sourceProjectRef = source.sourceProjectKey === 'default' ? null : source.sourceProjectKey;
    return (connection.agentName === route.agentName &&
        connection.channel === channel &&
        connection.projectKey === sourceProjectRef &&
        connection.resolvedProjectKey === source.sourceProjectKey);
}
async function runTrustedRouteRepair(operations, repair) {
    const { connection, binding } = repair;
    const transportKey = `${binding.channel}\u0000${binding.clientName}`;
    return operations.connectionLane.run(connection.connectionId, () => operations.bindingLane.run(transportKey, () => operations.bindingSessionLane.run(binding.bindingId, () => mutateTrustedRouteRepair(operations, repair))));
}
/** Runs the durable mutation and maps its result onto the repair outcome. */
async function mutateTrustedRouteRepair(operations, repair) {
    let outcome = 'unproven';
    await mutateDurableYaml(operations.bindingsPath, (document) => {
        const result = applyTrustedRouteRepair(operations, repair, document);
        outcome = result.outcome;
        return { changed: result.outcome === 'repaired', value: undefined };
    });
    return outcome;
}
/** Durable half: revalidate the proven snapshot under the lanes, then move both rows. */
function applyTrustedRouteRepair(operations, repair, document) {
    const { route, channel, source, connection, binding } = repair;
    const data = readBindingData(document, operations.options.nowMs());
    const latestConnection = data.connections.get(connection.connectionId);
    const latestBinding = data.physicalBindings.get(binding.bindingId);
    if (!latestConnection ||
        !latestBinding ||
        !latestRowsStillProven({ latestConnection, latestBinding, repair })) {
        return { outcome: 'unproven' };
    }
    const latestState = assertImBindingRuntimeState(latestBinding, latestConnection);
    if (latestState.resolvedProjectKey !== source.sourceProjectKey ||
        latestState.currentSessionId !== source.sourceSessionId) {
        return { outcome: 'conflict' };
    }
    data.connections.set(latestConnection.connectionId, {
        ...latestConnection,
        projectKey: route.projectKey === 'default' ? null : route.projectKey,
        resolvedProjectKey: route.projectKey,
        updatedAt: operations.options.nowMs(),
    });
    data.physicalBindings.set(latestBinding.bindingId, {
        ...latestBinding,
        currentSessionId: source.trustedRootSessionId,
        resolvedProjectKey: route.projectKey,
        updatedAt: nextBindingUpdatedAt(latestBinding, operations.options.nowMs()),
    });
    writeBindingData(document, data);
    void channel;
    return { outcome: 'repaired' };
}
function latestRowsStillProven(check) {
    const { latestConnection, latestBinding } = check;
    const { route, channel, source, connection, binding } = check.repair;
    if (latestBinding.connectionId !== latestConnection.connectionId ||
        !latestBinding.migratedLegacyRouteKeys?.includes(route.key) ||
        !connectionOnProvenSource(latestConnection, route, channel, source)) {
        return false;
    }
    // The optimistic snapshot must be byte-current (CAS on both timestamps).
    if (latestConnection.updatedAt !== connection.updatedAt ||
        latestBinding.updatedAt !== binding.updatedAt) {
        return false;
    }
    return !(source.repairsLegacyRootCursor &&
        (latestConnection.createdAt !== latestConnection.updatedAt ||
            latestBinding.createdAt !== latestBinding.updatedAt));
}
/**
 * A historic Root becomes visible only after the exact credential route was
 * adopted by a physical Binding. `trustedRootSessionId` is produced solely
 * by host-side owner, snapshot, and Project verification; the receipt then
 * proves that this Binding, rather than an arbitrary hidden Root, consumed
 * that source row. A later `/new` may advance this Binding cursor without
 * invalidating the already adopted historical Session.
 */
async function revealTrustedImLegacyCredentialSessions(operations, routes) {
    const reveal = operations.options.revealMigratedSession;
    if (!reveal)
        return;
    const revealed = new Set();
    for (const route of routes) {
        const trustedRootSessionId = route.trustedRootSessionId?.trim();
        const sessionId = route.sessionId.trim();
        if (!trustedRootSessionId ||
            route.emptyCursor ||
            trustedRootSessionId !== sessionId ||
            revealed.has(sessionId)) {
            continue;
        }
        if (!(await routeAdoptedByReceiptBinding(operations, route)))
            continue;
        await reveal(sessionId);
        revealed.add(sessionId);
    }
}
/** True when this exact legacy row was adopted by a matching physical Binding. */
async function routeAdoptedByReceiptBinding(operations, route) {
    const channel = legacyMigrationChannel(route.platform);
    const { bindingData } = await readImBindingState(operations);
    const binding = findReceiptBinding(bindingData, channel, route);
    if (!binding)
        return false;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection)
        throw invalidImStorage('physicalBindings', binding.bindingId);
    const state = assertImBindingRuntimeState(binding, connection);
    const matchesProject = connection.resolvedProjectKey === route.projectKey &&
        (route.projectKey === 'default'
            ? connection.projectKey === null
            : connection.projectKey === route.projectKey);
    return (connection.agentName === route.agentName &&
        connection.channel === channel &&
        matchesProject &&
        state.resolvedProjectKey === route.projectKey);
}
async function migrateExistingImBindingConversationState(operations) {
    const initial = readBindingData(await readYamlDocument(operations.bindingsPath), operations.options.nowMs());
    if ([...initial.physicalBindings.values()].every((binding) => binding.currentSessionId !== undefined &&
        binding.resolvedProjectKey !== undefined &&
        binding.mutationReceipts !== undefined)) {
        return;
    }
    const legacyDocument = await readYamlDocument(operations.routesPath);
    await mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        let changed = false;
        for (const binding of data.physicalBindings.values()) {
            if (hasMigratedConversationState(binding))
                continue;
            transferLegacyBindingState({ operations, data, binding, legacyDocument });
            changed = true;
        }
        if (changed)
            writeBindingData(document, data);
        return { changed, value: undefined };
    });
}
function hasMigratedConversationState(binding) {
    return (binding.currentSessionId !== undefined &&
        binding.resolvedProjectKey !== undefined &&
        binding.mutationReceipts !== undefined);
}
/**
 * Move one Binding's Session state off its legacy imConversation row. Every
 * mismatch is storage corruption: fail closed instead of guessing a cursor.
 */
function transferLegacyBindingState(transfer) {
    const { operations, data, binding, legacyDocument } = transfer;
    const connection = data.connections.get(binding.connectionId);
    const legacyConversation = binding.imConversationId
        ? readLegacyConversationById(legacyDocument, binding.imConversationId, operations.options.nowMs())
        : undefined;
    if (!connection || !legacyConversation) {
        throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_STATE_UNMIGRATED', 'The IM Binding cannot transfer its legacy Session state.');
    }
    if (!legacyStateTransferable(connection, binding, legacyConversation)) {
        throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    data.physicalBindings.set(binding.bindingId, {
        ...binding,
        currentSessionId: legacyConversation.currentSessionId,
        resolvedProjectKey: legacyConversation.projectKey,
        mutationReceipts: { ...legacyConversation.mutationReceipts },
        updatedAt: nextBindingUpdatedAt(binding, operations.options.nowMs()),
    });
}
function legacyStateTransferable(connection, binding, legacyConversation) {
    if (connection.agentName !== legacyConversation.agentName ||
        !connectionMatchesLegacyProject(connection, legacyConversation.projectKey)) {
        return false;
    }
    if (legacyConversation.connectionId &&
        legacyConversation.connectionId !== connection.connectionId) {
        return false;
    }
    return partialBindingStateAgrees(binding, legacyConversation);
}
/** projectKey 'default' persists as a null Connection projectKey. */
function connectionMatchesLegacyProject(connection, projectKey) {
    return (connection.resolvedProjectKey === projectKey &&
        (projectKey === 'default'
            ? connection.projectKey === null
            : connection.projectKey === projectKey));
}
/** Any already-present partial Binding state must equal the legacy row. */
function partialBindingStateAgrees(binding, legacyConversation) {
    return (!(binding.currentSessionId !== undefined &&
        binding.currentSessionId !== legacyConversation.currentSessionId) &&
        !(binding.resolvedProjectKey !== undefined &&
            binding.resolvedProjectKey !== legacyConversation.projectKey) &&
        !(binding.mutationReceipts !== undefined &&
            !sameMutationReceipts(binding.mutationReceipts, legacyConversation.mutationReceipts)));
}
function isLegacyRootStrategy(strategy) {
    return strategy === 'root' || strategy === 'main';
}
function sameMutationReceipts(current, expected) {
    const currentEntries = Object.entries(current).sort(([left], [right]) => left.localeCompare(right));
    const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
    return (currentEntries.length === expectedEntries.length &&
        currentEntries.every(([requestId, sessionId], index) => requestId === expectedEntries[index]?.[0] && sessionId === expectedEntries[index]?.[1]));
}
function legacyMigrationChannel(platform) {
    return platform === 'lark' ? 'feishu' : platform;
}
//# sourceMappingURL=im-connection-store-legacy-operations.js.map