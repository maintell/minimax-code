/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-operations.ts`.
 */
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { mutateDurableYaml, readYamlDocument } from '../storage/durable-yaml.js';
import { assertMessageFiltersDocument, findBindingForConnection, findBindingForTransportClient, invalidImStorage, readBindingData, readLegacyImMigrationTombstones, requireBindingSessionState, writeBindingData, } from './im-connection-store-data.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
export function getImAuthorization(operations, connectionId) {
    const authorization = operations.authorizations.get(connectionId);
    if (!authorization)
        return undefined;
    if (authorization.expiresAt !== undefined &&
        authorization.expiresAt <= operations.options.nowMs()) {
        operations.authorizations.delete(connectionId);
        return undefined;
    }
    return authorization;
}
export function findImAuthorizationByPlatformSession(operations, channel, platformSessionId) {
    for (const [connectionId] of operations.authorizations) {
        const authorization = getImAuthorization(operations, connectionId);
        if (authorization?.channel === channel &&
            authorization.platformSessionId === platformSessionId) {
            return connectionId;
        }
    }
    return undefined;
}
export async function getImConnection(operations, connectionId) {
    return readBindingData(await readYamlDocument(operations.bindingsPath), operations.options.nowMs()).connections.get(connectionId);
}
export async function requireImConnection(operations, connectionId) {
    const connection = await getImConnection(operations, connectionId);
    if (!connection) {
        throw new LocalImConnectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
    }
    return connection;
}
export function assertImBindingRuntimeState(binding, connection) {
    if (binding.connectionId !== connection.connectionId || binding.channel !== connection.channel) {
        throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    const state = requireBindingSessionState(binding);
    if (state.resolvedProjectKey !== connection.resolvedProjectKey) {
        throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_PROJECT_MISMATCH', 'The IM Binding Project does not match its Connection.');
    }
    return state;
}
export async function readImBindingState(operations) {
    const bindingsDocument = await readYamlDocument(operations.bindingsPath);
    const bindingData = readBindingData(bindingsDocument, operations.options.nowMs());
    const tombstones = readLegacyImMigrationTombstones(bindingsDocument, operations.options.nowMs());
    return { bindingData, tombstones };
}
export function bindingConversationOperations(operations) {
    return {
        bindingsPath: operations.bindingsPath,
        bindingSessionLane: operations.bindingSessionLane,
        options: operations.options,
    };
}
export async function clearImPendingLegacyMigration(operations, connectionId) {
    await mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const connection = data.connections.get(connectionId);
        if (!connection?.pendingLegacyRouteKeys?.length) {
            return { changed: false, value: undefined };
        }
        data.connections.set(connectionId, {
            ...connection,
            pendingLegacyRouteKeys: undefined,
            updatedAt: operations.options.nowMs(),
        });
        writeBindingData(document, data);
        return { changed: true, value: undefined };
    });
}
export async function getImBindingForConnection(operations, connectionId) {
    const data = readBindingData(await readYamlDocument(operations.bindingsPath), operations.options.nowMs());
    return findBindingForConnection(data.physicalBindings, connectionId);
}
export async function getImBindingForTransportClient(operations, channel, clientName) {
    const data = readBindingData(await readYamlDocument(operations.bindingsPath), operations.options.nowMs());
    return findBindingForTransportClient(data.physicalBindings, channel, clientName);
}
export async function getImDeletionSnapshot(operations, connectionId) {
    const document = await readYamlDocument(operations.bindingsPath);
    const data = readBindingData(document, operations.options.nowMs());
    const connection = data.connections.get(connectionId);
    if (!connection)
        return undefined;
    const binding = findBindingForConnection(data.physicalBindings, connectionId);
    // Validate before external cleanup, so malformed local data cannot cause a partial unbind.
    if (binding)
        assertMessageFiltersDocument(document);
    const authorization = getImAuthorization(operations, connectionId);
    return {
        connection,
        ...(binding ? { binding } : {}),
        ...(authorization ? { authorization } : {}),
    };
}
export function normalizeLegacyRouteKeys(keys) {
    if (!keys)
        return [];
    const normalized = keys.map((key) => key.trim());
    if (normalized.some((key) => !key)) {
        throw new LocalImConnectionError(400, 'CHANNEL_CONNECTION_MIGRATION_INVALID', 'Legacy migration receipt keys must be non-empty.');
    }
    return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}
export function sameLegacyRouteKeys(current, next) {
    const normalizedCurrent = normalizeLegacyRouteKeys(current);
    return (normalizedCurrent.length === next.length &&
        normalizedCurrent.every((key, index) => key === next[index]));
}
//# sourceMappingURL=im-connection-store-operations.js.map