const VALID_PLATFORMS = new Set(['feishu', 'telegram', 'wechat']);
const P2P_CHAT_TYPES = new Set(['p2p', 'private', 'dm']);
export function defaultAccessControl() {
    return {
        allowedUsers: [],
        allowedGroups: [],
        groupMentionPolicy: 'mentionOnly',
        respondToMentionAll: false,
    };
}
export function evaluatePolicy(policy, ctx, ownerSenderId) {
    if (!isP2pChat(ctx.chatType)) {
        const groupDenial = evaluateGroupGates(policy, ctx);
        if (groupDenial)
            return groupDenial;
    }
    const ownerDecision = checkOwnerOnly(ctx, ownerSenderId);
    if (ownerDecision.decision === 'allow')
        return ownerDecision;
    if (policy.allowedUsers === 'ALL')
        return { decision: 'allow' };
    if (policy.allowedUsers.includes(ctx.senderId))
        return { decision: 'allow' };
    return { decision: 'deny', reason: 'user_not_allowed' };
}
/**
 * Group-chat gates in v1 evaluation order: group allowlist first, then the
 * mention policy. Returns undefined when the group gates pass.
 */
function evaluateGroupGates(policy, ctx) {
    if (Array.isArray(policy.allowedGroups) && policy.allowedGroups.length === 0) {
        return { decision: 'deny', reason: 'group_chat_disabled' };
    }
    if (policy.allowedGroups !== 'ALL' && !policy.allowedGroups.includes(ctx.chatId)) {
        return { decision: 'deny', reason: 'group_not_allowed' };
    }
    if (mentionGateDenies(policy, ctx)) {
        return { decision: 'deny', reason: 'mention_required' };
    }
    return undefined;
}
/** 'disabled' always denies; 'mentionOnly' requires a mention (or Feishu @all when allowed). */
function mentionGateDenies(policy, ctx) {
    if (policy.groupMentionPolicy === 'disabled')
        return true;
    return (policy.groupMentionPolicy === 'mentionOnly' &&
        ctx.hasMention !== true &&
        !(ctx.platform === 'feishu' && policy.respondToMentionAll && ctx.mentionAll === true));
}
export function isValidAccessControlKey(platform, clientName) {
    if (typeof platform !== 'string' || !VALID_PLATFORMS.has(platform))
        return false;
    return typeof clientName === 'string' && clientName.trim().length > 0;
}
export function parseAccessControlKey(key) {
    const idx = key.indexOf(':');
    if (idx <= 0)
        return undefined;
    const platform = key.slice(0, idx);
    const clientName = key.slice(idx + 1);
    if (!VALID_PLATFORMS.has(platform) || !clientName)
        return undefined;
    return { platform: platform, clientName };
}
export function clonePolicy(policy) {
    return {
        allowedUsers: policy.allowedUsers === 'ALL' ? 'ALL' : [...policy.allowedUsers],
        allowedGroups: policy.allowedGroups === 'ALL' ? 'ALL' : [...policy.allowedGroups],
        groupMentionPolicy: policy.groupMentionPolicy,
        respondToMentionAll: policy.respondToMentionAll,
    };
}
export function normalizePolicy(raw) {
    const base = defaultAccessControl();
    const record = raw;
    const legacyAllowGroupChat = readBoolean(record.allowGroupChat ?? record.allow_group_chat);
    const allowedGroups = readAllowlist(record.allowedGroups ?? record.allowed_groups, base.allowedGroups);
    return {
        allowedUsers: readUserAllowlist(record.allowedUsers ?? record.allowed_users, readBoolean(record.ownerOnly ?? record.owner_only), base.allowedUsers),
        allowedGroups: legacyAllowGroupChat === false ? [] : allowedGroups,
        groupMentionPolicy: readMentionPolicy(record.groupMentionPolicy ?? record.group_mention_policy) ??
            base.groupMentionPolicy,
        respondToMentionAll: readBoolean(record.respondToMentionAll ?? record.respond_to_mention_all) ??
            base.respondToMentionAll,
    };
}
export function policySummary(policy) {
    return {
        groupMentionPolicy: policy.groupMentionPolicy,
        respondToMentionAll: policy.respondToMentionAll,
        allowedUsersMode: policy.allowedUsers === 'ALL' ? 'ALL' : `list(${policy.allowedUsers.length})`,
        allowedGroupsMode: policy.allowedGroups === 'ALL' ? 'ALL' : `list(${policy.allowedGroups.length})`,
    };
}
function checkOwnerOnly(ctx, ownerSenderId) {
    if (ownerSenderId === undefined)
        return { decision: 'deny', reason: 'owner_only' };
    if (ownerSenderId !== ctx.senderId)
        return { decision: 'deny', reason: 'owner_only' };
    return { decision: 'allow' };
}
function isP2pChat(chatType) {
    if (!chatType)
        return false;
    return P2P_CHAT_TYPES.has(chatType.trim().toLowerCase());
}
function readAllowlist(value, fallback) {
    if (typeof value === 'string')
        return value.trim().toUpperCase() === 'ALL' ? 'ALL' : fallback;
    if (!Array.isArray(value))
        return fallback;
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const trimmed = item.trim();
        if (trimmed.toUpperCase() === 'ALL')
            return 'ALL';
        if (trimmed)
            result.push(trimmed);
    }
    return result;
}
function readUserAllowlist(value, legacyOwnerOnly, fallback) {
    if (typeof value === 'string') {
        const normalized = value.trim().toUpperCase();
        if (normalized === 'ALL')
            return 'ALL';
        if (normalized === 'OWNER')
            return [];
        return fallback;
    }
    if (!Array.isArray(value)) {
        if (legacyOwnerOnly === true)
            return [];
        if (legacyOwnerOnly === false)
            return 'ALL';
        return fallback;
    }
    return readAllowlist(value, fallback);
}
function readBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function readMentionPolicy(value) {
    if (typeof value !== 'string')
        return undefined;
    const lower = value.trim().toLowerCase();
    if (lower === 'disabled')
        return 'disabled';
    if (lower === 'always')
        return 'always';
    if (lower === 'mentiononly' || lower === 'mention_only' || lower === 'mention-only')
        return 'mentionOnly';
    return undefined;
}
//# sourceMappingURL=access-control-policy.js.map