import { PinnedItemType, } from '@mavis/thrift-gen/generated/desktop-service/types';
export class LocalPinContractError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalPinContractError';
    }
}
export function validatePinnedItemRefs(items) {
    const seen = new Set();
    return items.map((item) => {
        const type = toStoredPinnedItemType(item.itemType);
        const id = type === 'project' ? validateProjectKey(item.id) : validateNonEmptyId(item.id, 'id');
        const key = `${type}:${id}`;
        if (seen.has(key)) {
            throw new LocalPinContractError(400, 'Pinned items must be unique', 'VALIDATION_ERROR');
        }
        seen.add(key);
        return { type, id };
    });
}
export function validateNonEmptyId(value, field) {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length === 0 || trimmed.length > 256) {
        throw new LocalPinContractError(400, `${field} is invalid`, 'VALIDATION_ERROR');
    }
    return trimmed;
}
export function validateProjectKey(value) {
    const key = validateNonEmptyId(value, 'project_key');
    if (key === 'default')
        return key;
    if (!key.startsWith('workspace:')) {
        throw new LocalPinContractError(400, 'project_key is invalid', 'VALIDATION_ERROR');
    }
    const workspace = key.slice('workspace:'.length);
    const absolute = workspace.startsWith('/') || /^[A-Za-z]:[\\/]/.test(workspace);
    if (!absolute) {
        throw new LocalPinContractError(400, 'project_key is invalid', 'VALIDATION_ERROR');
    }
    return key;
}
export function readExplicitAgentName(value) {
    if (!value.toLowerCase().startsWith('agent:'))
        return undefined;
    const name = value.slice('agent:'.length).trim();
    if (!name)
        throw new LocalPinContractError(400, 'id is invalid', 'VALIDATION_ERROR');
    return name;
}
function toStoredPinnedItemType(type) {
    if (type === PinnedItemType.Agent)
        return 'agent';
    if (type === PinnedItemType.Session)
        return 'session';
    if (type === PinnedItemType.Project)
        return 'project';
    throw new LocalPinContractError(400, 'Unsupported pinned item type', 'VALIDATION_ERROR');
}
export function updatePinnedRefs(refs, item, pinned, insertIndex) {
    const withoutItem = refs.filter((ref) => ref.type !== item.type || ref.id !== item.id);
    if (!pinned)
        return withoutItem;
    const index = clampInsertIndex(insertIndex, withoutItem.length);
    return [...withoutItem.slice(0, index), item, ...withoutItem.slice(index)];
}
export function updatePinnedAgentRefs(refs, canonicalId, compatibleNames, pinned, insertIndex) {
    const family = new Set([canonicalId, ...compatibleNames]);
    const withoutFamily = refs.filter((ref) => ref.type !== 'agent' || !family.has(ref.id));
    if (!pinned)
        return withoutFamily;
    const item = { type: 'agent', id: canonicalId };
    const index = clampInsertIndex(insertIndex, withoutFamily.length);
    return [...withoutFamily.slice(0, index), item, ...withoutFamily.slice(index)];
}
export function pinnedRefKey(item) {
    return `${item.type}:${item.id}`;
}
export function readLegacyPinnedFlag(session) {
    const raw = session;
    return raw.pinned === true || raw.pinned === 1 || Boolean(raw.pinnedAt ?? raw.pinned_at);
}
export function readLegacyPinnedAt(session) {
    const raw = session;
    const value = raw.pinnedAt ?? raw.pinned_at;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function clampInsertIndex(index, max) {
    if (index === undefined || !Number.isFinite(index))
        return max;
    return Math.max(0, Math.min(max, Math.trunc(index)));
}
//# sourceMappingURL=helpers.js.map