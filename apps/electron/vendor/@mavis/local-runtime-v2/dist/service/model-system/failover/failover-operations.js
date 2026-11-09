import { LocalModelProviderError } from '../contracts.js';
import { isModelAccessProvider, readModelAccessMetadata } from '../model-access/projection.js';
import { parseProviderId } from '../resolution/model-key.js';
import { CUSTOM_PROVIDER_ID_PREFIX } from '../identity.js';
import { FAILOVER_MAX_BACKUPS, failoverView, validateFailover, } from './pool-config.js';
function keyOf(providerId) {
    const parsed = parseProviderId(providerId);
    if (parsed?.source !== 'custom_provider')
        throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    return parsed.providerKey;
}
function project(view) {
    const member = ({ providerKey, ...rest }) => ({
        ...rest,
        providerId: `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`,
    });
    return {
        supported: view.supported,
        enabled: view.enabled,
        backups: view.backups.map(member),
        candidates: view.candidates.map(member),
        ...(view.selected
            ? { selected: view.selected.map((key) => `${CUSTOM_PROVIDER_ID_PREFIX}${key}`) }
            : {}),
    };
}
export function getModelAccessFailover(deps, port, providerId) {
    const requestedKey = keyOf(providerId);
    const providerKey = readModelAccessMetadata(deps.config().custom_provider?.[requestedKey])?.groupEntryKey ??
        requestedKey;
    const provider = deps.config().custom_provider?.[providerKey];
    if (!provider || !isModelAccessProvider(provider))
        throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    if (!port)
        return { supported: false, enabled: false, backups: [], candidates: [] };
    return project(failoverView(deps, port.state, providerKey));
}
/**
 * Persists the pool on the primary (provider keys only, in order). Disabling keeps the list so
 * re-enabling restores it; an empty list with `enabled` true is accepted and simply never pools.
 */
export async function setModelAccessFailover(deps, port, input) {
    if (!port)
        throw new LocalModelProviderError(400, 'Backup accounts are unavailable', 'MODEL_ACCESS_FAILOVER_UNSUPPORTED');
    if (typeof input.enabled !== 'boolean' || !Array.isArray(input.backups))
        throw new LocalModelProviderError(400, 'Invalid model access request', 'VALIDATION_ERROR');
    const requestedKey = keyOf(input.providerId);
    const providerKey = readModelAccessMetadata(deps.config().custom_provider?.[requestedKey])?.groupEntryKey ??
        requestedKey;
    const backups = validateFailover(deps, providerKey, input.backups.map((id) => {
        if (typeof id !== 'string')
            throw new LocalModelProviderError(400, 'Invalid backup account', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
        const parsed = parseProviderId(id);
        if (parsed?.source !== 'custom_provider')
            throw new LocalModelProviderError(400, 'Invalid backup account', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
        return parsed.providerKey;
    }));
    const members = input.members?.map(keyOf);
    if (members &&
        (members.length > FAILOVER_MAX_BACKUPS + 1 || new Set(members).size !== members.length))
        throw new LocalModelProviderError(400, 'Invalid account selection', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
    if (members)
        validateFailover(deps, providerKey, members.filter((key) => key !== providerKey));
    await deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        const provider = tree[providerKey];
        if (!provider || !isModelAccessProvider(provider))
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        const options = { ...(provider.options ?? {}) };
        const access = options.modelAccess;
        assertAccessRecord(access);
        if (members)
            validateFailover({ ...deps, config: () => ({ ...deps.config(), custom_provider: tree }) }, providerKey, members.filter((key) => key !== providerKey));
        options.modelAccess = {
            ...access,
            ...(members ? { groupEntryKey: providerKey } : {}),
            failover: { enabled: input.enabled, backups, ...(members ? { members } : {}) },
        };
        tree[providerKey] = { ...provider, options };
        if (members)
            assignMembers(tree, members, providerKey);
        draft.custom_provider = tree;
    });
    return project(failoverView(deps, port.state, providerKey));
}
function assignMembers(tree, members, root) {
    for (const key of members) {
        const member = tree[key];
        if (!member)
            continue;
        const existing = readModelAccessMetadata(member)?.groupEntryKey;
        if (existing && existing !== root)
            throw new LocalModelProviderError(400, 'Account belongs to another group', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
        member.options = {
            ...member.options,
            modelAccess: { ...member.options?.modelAccess, groupEntryKey: root },
        };
    }
}
function assertAccessRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
}
//# sourceMappingURL=failover-operations.js.map