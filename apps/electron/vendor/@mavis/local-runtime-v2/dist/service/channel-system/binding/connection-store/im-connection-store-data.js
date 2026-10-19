/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-data.ts`.
 */
import { randomUUID } from 'node:crypto';
import { asRecord, invalidImStorage, isChannel, normalizeConversation, numberValue, optionalString, readConversationEntityMap, } from './im-connection-store-data-codec.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
export { invalidImStorage, readBindingData, writeBindingData, } from './im-connection-store-data-codec.js';
export function legacyImMigrationProfile(agentName, channel) {
    return `${agentName}\u0000${channel}`;
}
export function readLegacyImMigrationTombstones(document, nowMs) {
    const raw = document.legacyImMigrationTombstones;
    if (raw === undefined)
        return new Map();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw invalidImStorage('legacyImMigrationTombstones');
    }
    const tombstones = new Map();
    for (const [key, value] of Object.entries(raw)) {
        const record = asRecord(value);
        const agentName = optionalString(record.agentName);
        const channel = optionalString(record.channel);
        if (!agentName || !isChannel(channel) || key !== legacyImMigrationProfile(agentName, channel)) {
            throw invalidImStorage('legacyImMigrationTombstones', key);
        }
        tombstones.set(key, {
            agentName,
            channel,
            createdAt: numberValue(record.createdAt) ?? nowMs,
        });
    }
    return tombstones;
}
export function writeLegacyImMigrationTombstones(document, tombstones) {
    if (tombstones.size === 0) {
        delete document.legacyImMigrationTombstones;
        return;
    }
    document.legacyImMigrationTombstones = Object.fromEntries([...tombstones.values()]
        .sort((left, right) => legacyImMigrationProfile(left.agentName, left.channel).localeCompare(legacyImMigrationProfile(right.agentName, right.channel)))
        .map((tombstone) => [
        legacyImMigrationProfile(tombstone.agentName, tombstone.channel),
        {
            agentName: tombstone.agentName,
            channel: tombstone.channel,
            createdAt: tombstone.createdAt,
        },
    ]));
}
/**
 * Reads exactly one retained legacy Conversation for the one-time Binding
 * state transfer. Online routes must use `requireBindingSessionState` instead.
 */
export function readLegacyConversationById(document, imConversationId, nowMs) {
    const normalizedId = optionalString(imConversationId);
    if (!normalizedId)
        return undefined;
    const rawConversations = readConversationEntityMap(document);
    const raw = rawConversations[normalizedId];
    if (raw === undefined)
        return undefined;
    const conversation = normalizeConversation(normalizedId, raw, nowMs);
    if (!conversation)
        throw invalidImStorage('imConversations', normalizedId);
    return conversation;
}
export function findConnection(connections, agentName, channel) {
    return [...connections.values()].find((connection) => connection.agentName === agentName && connection.channel === channel);
}
export function findBindingForConnection(bindings, connectionId) {
    return [...bindings.values()].find((binding) => binding.connectionId === connectionId);
}
export function findBindingForTransportClient(bindings, channel, clientName) {
    return [...bindings.values()].find((binding) => binding.channel === channel && binding.clientName === clientName);
}
export function samePhysicalBinding(current, expected) {
    if (!current || !expected)
        return current === expected;
    return (current.bindingId === expected.bindingId &&
        current.connectionId === expected.connectionId &&
        current.channel === expected.channel &&
        current.clientName === expected.clientName &&
        current.imConversationId === expected.imConversationId);
}
/** Fails closed if startup has not transferred legacy Conversation state. */
export function requireBindingSessionState(binding) {
    if (binding.currentSessionId === undefined ||
        !binding.resolvedProjectKey ||
        binding.mutationReceipts === undefined) {
        throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_STATE_UNMIGRATED', 'The IM Binding has not completed its Session state migration.');
    }
    return {
        currentSessionId: binding.currentSessionId,
        resolvedProjectKey: binding.resolvedProjectKey,
        mutationReceipts: binding.mutationReceipts,
    };
}
export function assertMessageFiltersDocument(document) {
    readMessageFilters(document);
}
export function deleteMessageFilter(document, clientName) {
    const filters = readMessageFilters(document);
    if (filters === undefined || !Object.prototype.hasOwnProperty.call(filters, clientName))
        return;
    const next = { ...filters };
    delete next[clientName];
    document.messageFilters = next;
}
export function requiredString(value, name) {
    const normalized = value.trim();
    if (!normalized) {
        throw new LocalImConnectionError(400, 'VALIDATION_ERROR', `${name} is required.`);
    }
    return normalized;
}
export function assertProjectKey(value) {
    if (!value.trim()) {
        throw new LocalImConnectionError(400, 'PROJECT_INVALID', 'Project is invalid.');
    }
}
export function assertChannel(value) {
    if (!isChannel(value)) {
        throw new LocalImConnectionError(400, 'CHANNEL_INVALID', 'Channel must be a supported string.');
    }
}
/**
 * Physical Binding `updatedAt` doubles as its durable cursor generation.
 * Wall-clock resolution is not sufficient for adjacent `/new` or `/clear`
 * mutations, so retain a strictly increasing value even within one millisecond
 * or after a clock rollback.
 */
export function nextBindingUpdatedAt(binding, nowMs) {
    const next = Math.max(binding.updatedAt + 1, nowMs);
    if (!Number.isSafeInteger(next)) {
        throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    return next;
}
function readMessageFilters(document) {
    const filters = document.messageFilters;
    if (filters === undefined)
        return undefined;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        throw invalidImStorage('messageFilters');
    }
    return filters;
}
export function newImEntityId(kind) {
    return `${kind}_${randomUUID()}`;
}
//# sourceMappingURL=im-connection-store-data.js.map