import { LocalImConnectionError, } from '../im-connection-types.js';
export function readBindingData(document, nowMs) {
    const rawConnections = requireNewEntityMap(document, 'connections');
    const rawBindings = requireNewEntityMap(document, 'physicalBindings');
    const connections = new Map();
    for (const [key, value] of Object.entries(rawConnections)) {
        const connection = normalizeConnection(key, value, nowMs);
        if (!connection)
            throw invalidImStorage('connections', key);
        connections.set(connection.connectionId, connection);
    }
    const physicalBindings = new Map();
    for (const [key, value] of Object.entries(rawBindings)) {
        const binding = normalizeBinding(key, value, nowMs);
        if (!binding)
            throw invalidImStorage('physicalBindings', key);
        physicalBindings.set(binding.bindingId, binding);
    }
    assertBindingFacts(connections, physicalBindings);
    return { connections, physicalBindings };
}
export function writeBindingData(document, data) {
    document.schemaVersion = Math.max(numberValue(document.schemaVersion) ?? 0, 3);
    const rawConnections = requireNewEntityMap(document, 'connections');
    const rawBindings = requireNewEntityMap(document, 'physicalBindings');
    document.connections = Object.fromEntries([...data.connections.values()]
        .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
        .map((connection) => {
        const previous = { ...asRecord(rawConnections[connection.connectionId]) };
        delete previous.pendingLegacyRouteKeys;
        return [connection.connectionId, { ...previous, ...serializeConnection(connection) }];
    }));
    document.physicalBindings = Object.fromEntries([...data.physicalBindings.values()]
        .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
        .map((binding) => [
        binding.bindingId,
        { ...asRecord(rawBindings[binding.bindingId]), ...serializeBinding(binding) },
    ]));
}
export function isChannel(value) {
    return value === 'feishu' || value === 'telegram' || value === 'wechat';
}
export function invalidImStorage(section, key) {
    return new LocalImConnectionError(409, 'CHANNEL_IM_STORAGE_INVALID', `Channel IM storage contains an invalid ${section}${key ? ` entry: ${key}` : ' section'}.`);
}
export function readConversationEntityMap(document) {
    return requireNewEntityMap(document, 'imConversations');
}
export function normalizeConversation(key, raw, nowMs) {
    const value = asRecord(raw);
    const imConversationId = entityIdForKey(value.imConversationId, key);
    const agentName = optionalString(value.agentName);
    const projectKey = optionalString(value.projectKey);
    // Pre-scope YAML rows were written by the one-version legacy migration and
    // intentionally remain one shared empty scope.
    const connectionId = value.connectionId === undefined ? '' : emptyString(value.connectionId);
    const currentSessionId = emptyString(value.currentSessionId);
    const identity = { imConversationId, agentName, projectKey, connectionId, currentSessionId };
    if (!isValidConversationShape(identity) || !validTimestampPair(value))
        return undefined;
    const receipts = readValidatedReceipts(value.mutationReceipts);
    if (!receipts)
        return undefined;
    return {
        ...identity,
        ...readRowTimestamps(value, nowMs),
        mutationReceipts: receipts,
    };
}
/** Required identity fields of a persisted imConversation row. */
function isValidConversationShape(fields) {
    return Boolean(fields.imConversationId &&
        fields.agentName &&
        fields.projectKey &&
        fields.connectionId !== undefined &&
        fields.currentSessionId !== undefined);
}
/** Both createdAt/updatedAt must be absent or numeric timestamps. */
function validTimestampPair(value) {
    return validOptionalTimestamp(value.createdAt) && validOptionalTimestamp(value.updatedAt);
}
/** Row timestamps with the shared now-fallback used by every codec. */
function readRowTimestamps(value, nowMs) {
    return {
        createdAt: numberValue(value.createdAt) ?? nowMs,
        updatedAt: numberValue(value.updatedAt) ?? nowMs,
    };
}
/** All receipt values must be strings; a malformed map invalidates the row. */
function readValidatedReceipts(raw) {
    if (!validMutationReceipts(raw))
        return undefined;
    const receipts = {};
    for (const [requestId, sessionId] of Object.entries(asRecord(raw))) {
        if (typeof sessionId !== 'string')
            return undefined;
        receipts[requestId] = sessionId;
    }
    return receipts;
}
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
export function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function normalizeConnection(key, raw, nowMs) {
    const value = asRecord(raw);
    const connectionId = entityIdForKey(value.connectionId, key);
    const agentName = optionalString(value.agentName);
    const channel = optionalString(value.channel);
    const resolvedProjectKey = optionalString(value.resolvedProjectKey);
    if (!connectionId || !agentName || !isChannel(channel) || !resolvedProjectKey)
        return undefined;
    if (!validOptionalStringOrNull(value.projectKey) ||
        !validLegacyRouteKeys(value.pendingLegacyRouteKeys) ||
        !validTimestampPair(value))
        return undefined;
    return {
        connectionId,
        agentName,
        channel,
        projectKey: optionalString(value.projectKey) ?? null,
        resolvedProjectKey,
        ...readPendingLegacyRouteKeys(value),
        ...readRowTimestamps(value, nowMs),
    };
}
/** Non-empty pending key arrays survive verbatim; empty ones stay omitted. */
function readPendingLegacyRouteKeys(value) {
    return Array.isArray(value.pendingLegacyRouteKeys) && value.pendingLegacyRouteKeys.length > 0
        ? { pendingLegacyRouteKeys: value.pendingLegacyRouteKeys }
        : {};
}
function normalizeBinding(key, raw, nowMs) {
    const value = asRecord(raw);
    const bindingId = entityIdForKey(value.bindingId, key);
    const connectionId = optionalString(value.connectionId);
    const channel = optionalString(value.channel);
    const clientName = optionalString(value.clientName);
    if (!bindingId || !connectionId || !isChannel(channel) || !clientName)
        return undefined;
    const optionalIdentity = readBindingOptionalIdentity(value);
    if (!optionalIdentity)
        return undefined;
    if (!validTimestampPair(value) ||
        !validLegacyRouteKeys(value.migratedLegacyRouteKeys) ||
        !validMutationReceipts(value.mutationReceipts))
        return undefined;
    return {
        bindingId,
        connectionId,
        channel,
        clientName,
        ...optionalIdentity,
        ...readBindingOptionalMaps(value),
        ...readRowTimestamps(value, nowMs),
    };
}
/**
 * Optional identity columns with their exact v1 presence semantics: an
 * explicitly-present-but-invalid column invalidates the whole row (returns
 * undefined), while an absent column is simply omitted from the result.
 */
function readBindingOptionalIdentity(value) {
    const imConversationId = optionalString(value.imConversationId);
    const currentSessionId = value.currentSessionId === undefined ? undefined : emptyString(value.currentSessionId);
    const resolvedProjectKey = value.resolvedProjectKey === undefined ? undefined : optionalString(value.resolvedProjectKey);
    if (value.currentSessionId !== undefined && currentSessionId === undefined)
        return undefined;
    if (value.resolvedProjectKey !== undefined && !resolvedProjectKey)
        return undefined;
    return {
        ...(imConversationId ? { imConversationId } : {}),
        ...(currentSessionId !== undefined ? { currentSessionId } : {}),
        ...(resolvedProjectKey ? { resolvedProjectKey } : {}),
    };
}
/** Optional receipt/migration maps preserved with their v1 spread semantics. */
function readBindingOptionalMaps(value) {
    const migratedLegacyRouteKeys = Array.isArray(value.migratedLegacyRouteKeys)
        ? value.migratedLegacyRouteKeys
        : undefined;
    const mutationReceipts = value.mutationReceipts === undefined
        ? undefined
        : Object.fromEntries(Object.entries(asRecord(value.mutationReceipts)).map(([requestId, sessionId]) => [
            requestId,
            String(sessionId),
        ]));
    return {
        ...(mutationReceipts !== undefined ? { mutationReceipts } : {}),
        ...(migratedLegacyRouteKeys && migratedLegacyRouteKeys.length > 0
            ? { migratedLegacyRouteKeys }
            : {}),
    };
}
function serializeConnection(connection) {
    return {
        connectionId: connection.connectionId,
        agentName: connection.agentName,
        channel: connection.channel,
        projectKey: connection.projectKey,
        resolvedProjectKey: connection.resolvedProjectKey,
        ...(connection.pendingLegacyRouteKeys?.length
            ? { pendingLegacyRouteKeys: [...connection.pendingLegacyRouteKeys] }
            : {}),
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
    };
}
function serializeBinding(binding) {
    return {
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        channel: binding.channel,
        clientName: binding.clientName,
        ...(binding.imConversationId ? { imConversationId: binding.imConversationId } : {}),
        ...(binding.currentSessionId !== undefined
            ? { currentSessionId: binding.currentSessionId }
            : {}),
        ...(binding.resolvedProjectKey ? { resolvedProjectKey: binding.resolvedProjectKey } : {}),
        ...(binding.mutationReceipts !== undefined
            ? { mutationReceipts: binding.mutationReceipts }
            : {}),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
        ...(binding.migratedLegacyRouteKeys
            ? { migratedLegacyRouteKeys: [...binding.migratedLegacyRouteKeys] }
            : {}),
    };
}
/** YAML has no database constraints, so validate the durable uniqueness facts on every read. */
function assertBindingFacts(connections, physicalBindings) {
    const connectionProfiles = new Set();
    for (const connection of connections.values()) {
        const profile = `${connection.agentName}\u0000${connection.channel}`;
        if (connectionProfiles.has(profile))
            throw invalidImStorage('connections', connection.connectionId);
        connectionProfiles.add(profile);
    }
    const connectionBindings = new Set();
    const transportClients = new Set();
    for (const binding of physicalBindings.values()) {
        const connection = connections.get(binding.connectionId);
        if (!connection || connection.channel !== binding.channel) {
            throw invalidImStorage('physicalBindings', binding.bindingId);
        }
        if (connectionBindings.has(binding.connectionId)) {
            throw invalidImStorage('physicalBindings', binding.bindingId);
        }
        connectionBindings.add(binding.connectionId);
        const transportClient = `${binding.channel}\u0000${binding.clientName}`;
        if (transportClients.has(transportClient)) {
            throw invalidImStorage('physicalBindings', binding.bindingId);
        }
        transportClients.add(transportClient);
    }
}
function emptyString(value) {
    return typeof value === 'string' ? value.trim() : undefined;
}
/** New-map key and explicit entity id must be stable under a read/write cycle. */
function entityIdForKey(value, key) {
    const normalizedKey = optionalString(key);
    if (!normalizedKey)
        return undefined;
    if (value === undefined)
        return normalizedKey;
    const explicit = optionalString(value);
    return explicit && explicit === normalizedKey ? explicit : undefined;
}
export function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** New model sections fail closed while legacy route rows remain opaque. */
function requireNewEntityMap(document, section) {
    const raw = document[section];
    if (raw === undefined)
        return {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw invalidImStorage(section);
    return raw;
}
function validOptionalStringOrNull(value) {
    return (value === undefined || value === null || (typeof value === 'string' && Boolean(value.trim())));
}
function validOptionalTimestamp(value) {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
function validLegacyRouteKeys(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string' && Boolean(entry.trim()))));
}
function validMutationReceipts(value) {
    return (value === undefined ||
        (Boolean(value) &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.entries(value).every(([requestId, sessionId]) => Boolean(requestId) && typeof sessionId === 'string' && Boolean(sessionId.trim()))));
}
//# sourceMappingURL=im-connection-store-data-codec.js.map