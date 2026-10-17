import { LocalConfigValidationError } from './raw-config.js';
// BYOK trees ('minimax_api', 'custom_provider') are intentionally excluded
// from both whitelists below: they hold plaintext API keys and must only be
// written through the dedicated ModelProvider API. Allowing them here would
// reopen the masked-value read-modify-write hazard — GET /config returns
// masked keys, so writing that payload back would clobber the real keys.
const LOCAL_CONFIG_MUTABLE_FIELDS = new Set([
    'permissionMode',
    'defaultModel',
    'defaultModelVariant',
    'defaultLightModel',
    'provider',
    'asr',
    'sseErrorPush',
    'beta',
    'nexus',
    'thinking',
    'memory',
    'review',
    'worktreeRefreshBeforeCreate',
    'agents',
    'dataContribution',
]);
// Roots whose child keys are open-ended (model ids, agent names, beta flags…).
// A dotted write only has to name the root; the leaf key cannot be enumerated.
const LOCAL_CONFIG_DOTTED_MUTABLE_ROOTS = new Set([
    'provider',
    'asr',
    'sseErrorPush',
    'beta',
    'nexus',
    'thinking',
    'memory',
    'agents',
]);
// Roots whose children are a closed, known set. Whitelisting only the root
// would let any `<root>.<anything>` land in config.yaml, so dotted writes here
// must match the full field path.
const EXACT_DOTTED_MUTABLE_ROOTS = new Set(['review', 'dataContribution']);
const EXACT_DOTTED_MUTABLE_FIELDS = new Set([
    'review.mode',
    'review.turnDiffCard',
    'dataContribution.enabled',
]);
const LOCAL_PERMISSION_MODES = new Set([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'auto',
    'off',
]);
export const DANGEROUS_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
export function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function assertMutableConfigField(field) {
    if (field === 'permission.policyOwner' || field === 'permission.storageWriteVersion')
        return;
    const parts = field.split('.');
    const [root, ...children] = parts;
    if (!root ||
        parts.some((part) => !part || DANGEROUS_CONFIG_PATH_SEGMENTS.has(part)) ||
        !LOCAL_CONFIG_MUTABLE_FIELDS.has(root) ||
        (children.length > 0 &&
            (EXACT_DOTTED_MUTABLE_ROOTS.has(root)
                ? !EXACT_DOTTED_MUTABLE_FIELDS.has(field)
                : !LOCAL_CONFIG_DOTTED_MUTABLE_ROOTS.has(root)))) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "${field}"`);
    }
}
export function assertSafeConfigRecord(record) {
    for (const [key, value] of Object.entries(record)) {
        if (!key || DANGEROUS_CONFIG_PATH_SEGMENTS.has(key)) {
            throw new LocalConfigValidationError(`Local runtime cannot update config field segment "${key}"`);
        }
        if (isPlainRecord(value))
            assertSafeConfigRecord(value);
    }
}
export function validateLocalConfigValue(field, value) {
    if (field === 'permission.policyOwner') {
        if (value === 'engine' || value === 'core')
            return value;
        throw new LocalConfigValidationError(`Invalid permission.policyOwner "${String(value)}"`);
    }
    if (field === 'permission.storageWriteVersion') {
        if (value === 1 || value === 2)
            return value;
        throw new LocalConfigValidationError(`Invalid permission.storageWriteVersion "${String(value)}"`);
    }
    if (field === 'permissionMode') {
        if (typeof value === 'string' && LOCAL_PERMISSION_MODES.has(value))
            return value;
        throw new LocalConfigValidationError(`Invalid permissionMode "${String(value)}"`);
    }
    if (field === 'worktreeRefreshBeforeCreate') {
        if (typeof value === 'boolean')
            return value;
        throw new LocalConfigValidationError('Invalid worktreeRefreshBeforeCreate');
    }
    if (field === 'review.mode') {
        return validateReviewMode(value);
    }
    if (field === 'review.turnDiffCard') {
        return validateTurnDiffCardMode(value);
    }
    if (field === 'review') {
        if (!isPlainRecord(value)) {
            throw new LocalConfigValidationError('Invalid review config');
        }
        return validateReviewConfigRecord(value);
    }
    if (field === 'dataContribution.enabled') {
        if (typeof value === 'boolean')
            return value;
        throw new LocalConfigValidationError(`Invalid dataContribution.enabled "${String(value)}"`);
    }
    if (field === 'dataContribution') {
        if (!isPlainRecord(value)) {
            throw new LocalConfigValidationError('Invalid dataContribution config');
        }
        return validateDataContributionConfigRecord(value);
    }
    if (field === 'defaultModelVariant' && typeof value !== 'string') {
        throw new LocalConfigValidationError(`Invalid defaultModelVariant "${String(value)}"`);
    }
    return value;
}
function validateDataContributionConfigRecord(value) {
    const invalidKey = Object.keys(value).find((key) => key !== 'enabled');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "dataContribution.${invalidKey}"`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'enabled') &&
        typeof value.enabled !== 'boolean') {
        throw new LocalConfigValidationError(`Invalid dataContribution.enabled "${String(value.enabled)}"`);
    }
    return { ...value };
}
export function validateReviewConfigRecord(value) {
    const keys = Object.keys(value);
    const invalidKey = keys.find((key) => key !== 'mode' && key !== 'turnDiffCard');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "review.${invalidKey}"`);
    }
    return {
        ...(Object.prototype.hasOwnProperty.call(value, 'mode')
            ? { mode: validateReviewMode(value.mode) }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(value, 'turnDiffCard')
            ? { turnDiffCard: validateTurnDiffCardMode(value.turnDiffCard) }
            : {}),
    };
}
function validateReviewMode(value) {
    if (value === 'inline' || value === 'subagent')
        return value;
    throw new LocalConfigValidationError(`Invalid review.mode "${String(value)}"`);
}
function validateTurnDiffCardMode(value) {
    if (value === 'concise' || value === 'standard')
        return value;
    throw new LocalConfigValidationError(`Invalid review.turnDiffCard "${String(value)}"`);
}
//# sourceMappingURL=update-policy.js.map