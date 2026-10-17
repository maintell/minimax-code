/**
 * Migration copy (MR1) of v1 `channels/channel-binding-codec.ts`. Codec for
 * the legacy `bindings`/`messageFilters` sections of `channel-bindings.yaml`;
 * unknown raw fields must survive a rewrite (see mergeChannelBindingsIntoDocument).
 */
import { channelRoutingModeForStrategy } from '@mavis/shared';
import { inferPlatformFromClientName } from '../routing/client-owner-routing.js';
import { buildLocalChannelBindingKey } from '../ingress/channel-inbound-utils.js';
export function serializeChannelBinding(binding) {
    return { ...binding };
}
/**
 * Resolve the transport identity of a persisted binding row. Field priority is
 * the row itself, then the parsed map key, then platform inference from the
 * clientName prefix (legacy rows lack an explicit platform).
 */
function readPersistedBindingIdentity(key, raw) {
    const keyParts = parseBindingKeyParts(key);
    const clientName = readFirstString(raw, ['clientName']) ?? keyParts.clientName;
    const platform = normalizePlatform(readFirstString(raw, ['platform'])) ??
        inferPlatformFromClientName(clientName) ??
        'feishu';
    const chatId = readFirstString(raw, ['chatId']) ?? keyParts.chatId;
    const senderId = readFirstString(raw, ['senderId']) ?? keyParts.senderId;
    const threadId = readFirstString(raw, ['threadId']) ?? '';
    const lane = (readFirstString(raw, ['lane']) ?? 'interactive');
    // A row that carried its own platform keeps its original map key; a legacy
    // row without one is re-keyed canonically from the resolved identity.
    const resolvedKey = readFirstString(raw, ['key']) ??
        (readFirstString(raw, ['platform'])
            ? key
            : buildLocalChannelBindingKey({
                platform,
                clientName,
                chatId,
                senderId,
                threadId,
                lane,
                chatType: '*',
            }));
    return { clientName, platform, chatId, senderId, threadId, lane, key: resolvedKey };
}
export function normalizeChannelBinding(key, value, nowMs) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    const agentName = readFirstString(raw, ['agentName', 'agentId']);
    const sessionId = readFirstString(raw, ['sessionId']);
    if (!agentName || !sessionId)
        return undefined;
    const identity = readPersistedBindingIdentity(key, raw);
    const { clientName, platform, chatId, senderId, threadId, lane } = identity;
    const strategy = normalizeStrategy(readFirstString(raw, ['strategy']));
    return {
        key: identity.key,
        platform,
        clientName,
        chatId,
        senderId,
        threadId,
        lane,
        agentName,
        sessionId,
        strategy,
        pinned: raw.pinned === true,
        routeRuleId: readFirstString(raw, ['routeRuleId']) ?? null,
        createdAt: readNumber(raw.createdAt) ?? nowMs,
        updatedAt: readNumber(raw.updatedAt) ?? nowMs,
        ...readPersistedBindingGovernance(raw, agentName, strategy),
    };
}
/** Additive v2 owner/Project/CAS fields with their legacy-row defaults. */
function readPersistedBindingGovernance(raw, agentName, strategy) {
    const ownerInstanceId = readFirstString(raw, ['ownerInstanceId']);
    return {
        exactOwnerName: readFirstString(raw, ['exactOwnerName']) ?? agentName,
        ...(ownerInstanceId ? { ownerInstanceId } : {}),
        projectKey: normalizeProjectKey(readFirstString(raw, ['projectKey'])),
        routingMode: normalizeRoutingMode(readFirstString(raw, ['routingMode']), strategy),
        generation: Math.max(0, Math.trunc(readNumber(raw.generation) ?? 0)),
    };
}
export function normalizeChannelMessageFilter(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    return {
        mode: raw.mode === 'full' ? 'full' : 'result',
        includeToolSummary: raw.includeToolSummary === true,
    };
}
export function defaultChannelMessageFilter() {
    return { mode: 'result', includeToolSummary: false };
}
export function validChannelBindingRawKeys(document, nowMs) {
    const bindings = new Map();
    for (const [rawKey, value] of Object.entries(asRecord(document.bindings))) {
        const normalized = normalizeChannelBinding(rawKey, value, nowMs);
        if (normalized)
            bindings.set(normalized.key, rawKey);
    }
    const filters = new Set();
    for (const [clientId, value] of Object.entries(asRecord(document.messageFilters))) {
        if (normalizeChannelMessageFilter(value))
            filters.add(clientId);
    }
    return { bindings, filters };
}
export function mergeChannelBindingsIntoDocument(document, bindings, filters, prior) {
    const rawBindings = { ...asRecord(document.bindings) };
    const previousByNormalizedKey = new Map();
    for (const [normalizedKey, rawKey] of prior.bindings) {
        previousByNormalizedKey.set(normalizedKey, asRecord(rawBindings[rawKey]));
        delete rawBindings[rawKey];
    }
    for (const [key, binding] of [...bindings].sort(([left], [right]) => left.localeCompare(right))) {
        rawBindings[key] = {
            ...previousByNormalizedKey.get(key),
            ...serializeChannelBinding(binding),
        };
    }
    const rawFilters = { ...asRecord(document.messageFilters) };
    const previousFilters = new Map();
    for (const clientId of prior.filters) {
        previousFilters.set(clientId, asRecord(rawFilters[clientId]));
        delete rawFilters[clientId];
    }
    for (const [clientId, filter] of [...filters].sort(([left], [right]) => left.localeCompare(right))) {
        rawFilters[clientId] = { ...previousFilters.get(clientId), ...filter };
    }
    // `bindings` remains an opaque legacy per-route map while the IM
    // Connection model stores its own sibling sections in this same document.
    // A compatibility write must never downgrade schema v3 and make a real
    // runtime restart rewrite a document that already contains those sections.
    const existingSchemaVersion = document.schemaVersion;
    document.schemaVersion = Math.max(typeof existingSchemaVersion === 'number' && Number.isFinite(existingSchemaVersion)
        ? Math.trunc(existingSchemaVersion)
        : 0, 2);
    document.bindings = rawBindings;
    document.messageFilters = rawFilters;
}
export function hasMultiProjectChannelBindingProfile(bindings, replacement) {
    const projects = new Map();
    for (const binding of bindings) {
        if (binding.key === replacement?.key)
            continue;
        const profile = [binding.exactOwnerName, binding.platform, binding.clientName].join('|');
        const existing = projects.get(profile);
        if (existing !== undefined && existing !== binding.projectKey)
            return true;
        projects.set(profile, binding.projectKey);
    }
    if (!replacement)
        return false;
    const profile = [replacement.exactOwnerName, replacement.platform, replacement.clientName].join('|');
    const existing = projects.get(profile);
    return existing !== undefined && existing !== replacement.projectKey;
}
export function channelBindingProjectConflicts(input) {
    const { bindings, ...replacement } = input;
    return hasMultiProjectChannelBindingProfile(bindings, replacement);
}
function parseBindingKeyParts(key) {
    const parts = key.split(':').map((part) => {
        try {
            return decodeURIComponent(part);
        }
        catch {
            return part;
        }
    });
    if (parts.length >= 6 && normalizePlatform(parts[0])) {
        return {
            clientName: parts[1] ?? '',
            chatId: parts[2] ?? '',
            senderId: parts[3] ?? '',
        };
    }
    return {
        clientName: parts[0] ?? '',
        chatId: parts[1] ?? '',
        senderId: parts.slice(2).join(':'),
    };
}
function normalizeStrategy(value) {
    return value === 'pin' ||
        value === 'root' ||
        value === 'main' ||
        value === 'per-sender' ||
        value === 'per-chat' ||
        value === 'shared-task'
        ? value
        : 'root';
}
function normalizePlatform(value) {
    return value === 'feishu' || value === 'telegram' || value === 'wechat' ? value : undefined;
}
function normalizeProjectKey(value) {
    return value === 'default' || value?.startsWith('workspace:') ? value : 'default';
}
function normalizeRoutingMode(value, strategy) {
    return value === 'project-main' ||
        value === 'per-sender' ||
        value === 'per-chat' ||
        value === 'shared-task'
        ? value
        : channelRoutingModeForStrategy(strategy);
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function readFirstString(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
//# sourceMappingURL=channel-binding-codec.js.map