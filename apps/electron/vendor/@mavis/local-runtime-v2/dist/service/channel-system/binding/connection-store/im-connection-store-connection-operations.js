/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-connection-operations.ts`.
 */
import { mutateDurableYaml } from '../storage/durable-yaml.js';
import { assertChannel, assertProjectKey, deleteMessageFilter, findBindingForConnection, findConnection, legacyImMigrationProfile, newImEntityId, readBindingData, readLegacyImMigrationTombstones, requiredString, samePhysicalBinding, writeBindingData, writeLegacyImMigrationTombstones, } from './im-connection-store-data.js';
import { assertImBindingRuntimeState, clearImPendingLegacyMigration, getImAuthorization, getImBindingForConnection, getImDeletionSnapshot, requireImConnection, readImBindingState, sameLegacyRouteKeys, normalizeLegacyRouteKeys, } from './im-connection-store-operations.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
export async function prepareImConnection(operations, input) {
    assertChannel(input.channel);
    assertProjectKey(input.resolvedProjectKey);
    operations.options.resolveProjectWorkspace(input.resolvedProjectKey);
    const agentName = requiredString(input.agentName, 'agentName');
    const pendingLegacyRouteKeys = normalizeLegacyRouteKeys(input.pendingLegacyRouteKeys);
    const connectionKey = input.connectionId?.trim() || `${agentName}\u0000${input.channel}`;
    return operations.connectionLane.run(connectionKey, () => mutateDurableYaml(operations.bindingsPath, (document) => {
        const prepare = {
            operations,
            input,
            agentName,
            pendingLegacyRouteKeys,
            document,
            data: readBindingData(document, operations.options.nowMs()),
            tombstones: readLegacyImMigrationTombstones(document, operations.options.nowMs()),
        };
        const existing = input.connectionId?.trim()
            ? prepare.data.connections.get(input.connectionId.trim())
            : findConnection(prepare.data.connections, agentName, input.channel);
        if (input.connectionId?.trim() && !existing) {
            throw new LocalImConnectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
        }
        if (!existing)
            return createPreparedConnection(prepare);
        return updatePreparedConnection(prepare, existing);
    }));
}
/** Insert a fresh Connection row (no prior row for this Agent+Channel). */
function createPreparedConnection(prepare) {
    const { operations, input, agentName, pendingLegacyRouteKeys, data, tombstones } = prepare;
    const now = operations.options.nowMs();
    const created = {
        connectionId: newImEntityId('connection'),
        agentName,
        channel: input.channel,
        projectKey: input.projectKey,
        resolvedProjectKey: input.resolvedProjectKey,
        ...(pendingLegacyRouteKeys.length > 0
            ? { pendingLegacyRouteKeys: [...pendingLegacyRouteKeys] }
            : {}),
        createdAt: now,
        updatedAt: now,
    };
    data.connections.set(created.connectionId, created);
    if (pendingLegacyRouteKeys.length === 0) {
        tombstones.delete(legacyImMigrationProfile(agentName, input.channel));
    }
    writeBindingData(prepare.document, data);
    writeLegacyImMigrationTombstones(prepare.document, tombstones);
    return { changed: true, value: created };
}
/** v1 conflict gates: migration CAS + one Connection per Agent+Channel. */
function assertPreparedConnectionUpdatable(prepare, existing) {
    const { input, agentName, pendingLegacyRouteKeys, data } = prepare;
    if (pendingLegacyRouteKeys.length > 0 &&
        !sameLegacyRouteKeys(existing.pendingLegacyRouteKeys, pendingLegacyRouteKeys)) {
        throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_MIGRATION_CONFLICT', 'The pending legacy migration was superseded by current V2 state.');
    }
    const duplicate = findConnection(data.connections, agentName, input.channel);
    if (duplicate && duplicate.connectionId !== existing.connectionId) {
        throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_DUPLICATE', 'A Channel Connection already exists for this Agent and Channel.');
    }
}
/** A live Binding or an in-flight, non-errored authorization pins the target. */
function hasActiveTransportAttachment(prepare, existing) {
    const bound = findBindingForConnection(prepare.data.physicalBindings, existing.connectionId);
    if (bound)
        return true;
    const authorization = getImAuthorization(prepare.operations, existing.connectionId);
    return Boolean(authorization && !authorization.errorCode);
}
/** Re-target/refresh an existing Connection row after the v1 conflict gates. */
function updatePreparedConnection(prepare, existing) {
    const { operations, input, agentName, pendingLegacyRouteKeys, data, tombstones } = prepare;
    assertPreparedConnectionUpdatable(prepare, existing);
    const changedTarget = preparedTargetChanged(prepare, existing);
    const changedMigrationState = !sameLegacyRouteKeys(existing.pendingLegacyRouteKeys, pendingLegacyRouteKeys);
    if (changedTarget && hasActiveTransportAttachment(prepare, existing)) {
        const bound = Boolean(findBindingForConnection(data.physicalBindings, existing.connectionId));
        throw new LocalImConnectionError(409, bound ? 'CHANNEL_CONNECTION_BOUND_IMMUTABLE' : 'CHANNEL_CONNECTION_AUTHORIZING', bound
            ? 'A bound Channel Connection cannot change its Agent or Project.'
            : 'Cancel the active Channel authorization before changing its Project.');
    }
    if (!changedTarget && !changedMigrationState)
        return { changed: false, value: existing };
    const updated = {
        ...existing,
        agentName,
        channel: input.channel,
        projectKey: input.projectKey,
        resolvedProjectKey: input.resolvedProjectKey,
        ...(pendingLegacyRouteKeys.length > 0
            ? { pendingLegacyRouteKeys: [...pendingLegacyRouteKeys] }
            : { pendingLegacyRouteKeys: undefined }),
        updatedAt: operations.options.nowMs(),
    };
    data.connections.set(updated.connectionId, updated);
    if (pendingLegacyRouteKeys.length === 0) {
        tombstones.delete(legacyImMigrationProfile(agentName, input.channel));
    }
    writeBindingData(prepare.document, data);
    writeLegacyImMigrationTombstones(prepare.document, tombstones);
    return { changed: true, value: updated };
}
/** Does the prepare call re-target the row's Agent/Channel/Project identity? */
function preparedTargetChanged(prepare, existing) {
    const { input, agentName } = prepare;
    return (existing.agentName !== agentName ||
        existing.channel !== input.channel ||
        existing.projectKey !== input.projectKey ||
        existing.resolvedProjectKey !== input.resolvedProjectKey);
}
export async function findImConnection(operations, agentName, channel) {
    const { bindingData } = await readImBindingState(operations);
    return findConnection(bindingData.connections, agentName, channel);
}
export async function beginImAuthorization(operations, input) {
    return operations.connectionLane.run(input.connectionId, async () => {
        const connection = await requireImConnection(operations, input.connectionId);
        if (connection.channel !== input.channel) {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_CHANNEL_MISMATCH', 'Channel mismatch.');
        }
        if (await getImBindingForConnection(operations, connection.connectionId)) {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_ALREADY_BOUND', 'The Channel Connection is already bound.');
        }
        await clearImPendingLegacyMigration(operations, connection.connectionId);
        operations.authorizations.set(connection.connectionId, {
            channel: input.channel,
            ...(input.platformSessionId ? { platformSessionId: input.platformSessionId } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        });
    });
}
export async function cancelImAuthorization(operations, connectionId) {
    return operations.connectionLane.run(connectionId, async () => {
        await requireImConnection(operations, connectionId);
        await clearImPendingLegacyMigration(operations, connectionId);
        const hadAuthorization = getImAuthorization(operations, connectionId) !== undefined;
        operations.authorizations.delete(connectionId);
        const binding = await getImBindingForConnection(operations, connectionId);
        return { hadAuthorization, ...(binding ? { binding } : {}) };
    });
}
export async function expireImAuthorization(operations, connectionId) {
    await operations.connectionLane.run(connectionId, async () => {
        await requireImConnection(operations, connectionId);
        operations.authorizations.delete(connectionId);
    });
}
export async function markImAuthorizationError(operations, connectionId, channel, errorCode) {
    await operations.connectionLane.run(connectionId, async () => {
        const connection = await requireImConnection(operations, connectionId);
        if (connection.channel !== channel) {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_CHANNEL_MISMATCH', 'Channel mismatch.');
        }
        operations.authorizations.set(connectionId, { channel, errorCode });
    });
}
/** Permanently delete one IM Bot while retaining its historical Sessions. */
export async function deleteImConnection(operations, connectionId, beforeDelete) {
    return operations.connectionLane.run(connectionId, async () => {
        const snapshot = await getImDeletionSnapshot(operations, connectionId);
        // Public DELETE is idempotent and must not repeat external cleanup.
        if (!snapshot)
            return true;
        const deleteUnderTransportLane = async () => {
            // External credential cleanup is fail-closed and precedes local facts.
            await beforeDelete?.(snapshot);
            const deleted = await mutateDurableYaml(operations.bindingsPath, (document) => {
                const data = readBindingData(document, operations.options.nowMs());
                const currentConnection = data.connections.get(connectionId);
                if (!currentConnection)
                    return { changed: false, value: true };
                const currentBinding = findBindingForConnection(data.physicalBindings, connectionId);
                if (!samePhysicalBinding(currentBinding, snapshot.binding)) {
                    throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_DELETE_RACE', 'The Channel Connection changed while it was being deleted.');
                }
                if (currentBinding)
                    data.physicalBindings.delete(currentBinding.bindingId);
                data.connections.delete(connectionId);
                const tombstones = readLegacyImMigrationTombstones(document, operations.options.nowMs());
                tombstones.set(legacyImMigrationProfile(snapshot.connection.agentName, snapshot.connection.channel), {
                    agentName: snapshot.connection.agentName,
                    channel: snapshot.connection.channel,
                    createdAt: operations.options.nowMs(),
                });
                if (snapshot.binding)
                    deleteMessageFilter(document, snapshot.binding.clientName);
                writeBindingData(document, data);
                writeLegacyImMigrationTombstones(document, tombstones);
                return { changed: true, value: true };
            });
            operations.authorizations.delete(connectionId);
            return deleted;
        };
        if (!snapshot.binding)
            return deleteUnderTransportLane();
        const transportKey = `${snapshot.binding.channel}\u0000${snapshot.binding.clientName}`;
        return operations.bindingLane.run(transportKey, deleteUnderTransportLane);
    });
}
export async function listImConnectionViews(operations, channelFilter) {
    const { bindingData } = await readImBindingState(operations);
    return [...bindingData.connections.values()]
        .filter((connection) => !channelFilter || connection.channel === channelFilter)
        .sort((left, right) => left.createdAt - right.createdAt || left.connectionId.localeCompare(right.connectionId))
        .map((connection) => {
        const binding = findBindingForConnection(bindingData.physicalBindings, connection.connectionId);
        if (binding)
            assertImBindingRuntimeState(binding, connection);
        const authorization = getImAuthorization(operations, connection.connectionId);
        const state = resolveImConnectionState(binding, authorization);
        return {
            connection,
            state,
            ...(binding ? { binding } : {}),
            ...(authorization?.errorCode ? { errorCode: authorization.errorCode } : {}),
        };
    });
}
/**
 * Derive the wire-visible connection state. Priority mirrors the v1 nested
 * ternary: a live physical Binding wins, then an authorization error, then an
 * in-flight authorization, and only a bare credential reads `configured`.
 */
function resolveImConnectionState(binding, authorization) {
    if (binding)
        return 'bound';
    if (authorization?.errorCode)
        return 'error';
    if (authorization)
        return 'authorizing';
    return 'configured';
}
//# sourceMappingURL=im-connection-store-connection-operations.js.map