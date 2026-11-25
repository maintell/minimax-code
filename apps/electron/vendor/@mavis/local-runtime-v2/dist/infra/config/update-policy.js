import { isAskUserContextPolicy, isAskUserPolicy, isPluginRecommendationPluginName, isWorktreeKeepCount, PLUGIN_RECOMMENDATION_DISMISSED_MAX, } from '@mavis/config';
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
    'worktreeAutoCleanupEnabled',
    'worktreeKeepCount',
    'agents',
    'dataContribution',
    'askUser',
    'promptSuggestion',
    'quotaAutoResume',
    'nextStepBox',
    'advisor',
    'bunny',
    'pluginRecommendation',
    'subagent',
    'productionParity',
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
const EXACT_DOTTED_MUTABLE_ROOTS = new Set([
    'review',
    'dataContribution',
    'askUser',
    'promptSuggestion',
    'quotaAutoResume',
    'nextStepBox',
    'advisor',
    'bunny',
    'pluginRecommendation',
    'subagent',
]);
// `askUser.enabled` 刻意不在白名单里：它决定是否给模型 ask_user 工具，属于
// 运维开关，只能改 config.yaml；设置页只写三个提问策略。
export const ASK_USER_POLICY_FIELDS = new Set([
    'askUser.defaultPolicy',
    'askUser.goalPolicy',
    'askUser.planPolicy',
]);
const EXACT_DOTTED_MUTABLE_FIELDS = new Set([
    'review.mode',
    'review.turnDiffCard',
    'dataContribution.enabled',
    ...ASK_USER_POLICY_FIELDS,
    'promptSuggestion.enabled',
    'quotaAutoResume.enabled',
    'nextStepBox.enabled',
    'advisor.enabled',
    'bunny.enabled',
    'pluginRecommendation.enabled',
    'pluginRecommendation.dismissedPlugins',
    'subagent.maxConcurrentPerSession',
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
// The merge request limits stay config.yaml-only; Settings writes these two preferences.
const EXACT_MUTABLE_LEAVES = new Set([
    'miniAppSuggestion.enabled',
    'permission.policyOwner',
    'permission.storageWriteVersion',
    'permission.nativeDelete',
    'mergeRequests.createAsDraft',
    'mergeRequests.githubMergeMethod',
]);
export function assertMutableConfigField(field) {
    if (EXACT_MUTABLE_LEAVES.has(field))
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
const PERMISSION_CONFIG_VALUE_VALIDATORS = new Map([
    [
        'permission.policyOwner',
        (value) => {
            if (value === 'engine' || value === 'core')
                return value;
            throw new LocalConfigValidationError(`Invalid permission.policyOwner "${String(value)}"`);
        },
    ],
    [
        'permission.storageWriteVersion',
        (value) => {
            if (value === 1 || value === 2)
                return value;
            throw new LocalConfigValidationError(`Invalid permission.storageWriteVersion "${String(value)}"`);
        },
    ],
    [
        'permission.nativeDelete',
        (value) => {
            if (typeof value === 'boolean')
                return value;
            throw new LocalConfigValidationError('Invalid permission.nativeDelete: expected a boolean');
        },
    ],
    [
        'permissionMode',
        (value) => {
            if (typeof value === 'string' && LOCAL_PERMISSION_MODES.has(value))
                return value;
            throw new LocalConfigValidationError(`Invalid permissionMode "${String(value)}"`);
        },
    ],
]);
function validatePermissionConfigValue(field, value) {
    const validate = PERMISSION_CONFIG_VALUE_VALIDATORS.get(field);
    return validate ? validate(value) : value;
}
const LOCAL_CONFIG_VALUE_VALIDATORS = new Map([
    [
        'miniAppSuggestion.enabled',
        (value) => validateBoolean(value, 'miniAppSuggestion.enabled must be a boolean'),
    ],
    [
        'worktreeRefreshBeforeCreate',
        (value) => validateBoolean(value, 'Invalid worktreeRefreshBeforeCreate'),
    ],
    [
        'worktreeAutoCleanupEnabled',
        (value) => validateBoolean(value, 'Invalid worktreeAutoCleanupEnabled'),
    ],
    ['worktreeKeepCount', (value) => validateWorktreeKeepCount(value)],
    ['review.mode', (value) => validateReviewMode(value)],
    ['review.turnDiffCard', (value) => validateTurnDiffCardMode(value)],
    ['review', (value, field) => validateReviewConfigRecord(requireConfigRecord(field, value))],
    [
        'dataContribution.enabled',
        (value) => validateBoolean(value, `Invalid dataContribution.enabled "${String(value)}"`),
    ],
    [
        'dataContribution',
        (value, field) => validateDataContributionConfigRecord(requireConfigRecord(field, value)),
    ],
    ['defaultModelVariant', (value) => validateModelVariant(value)],
    [
        'promptSuggestion.enabled',
        (value) => validateBoolean(value, 'promptSuggestion.enabled must be a boolean'),
    ],
    [
        'quotaAutoResume.enabled',
        (value) => validateBoolean(value, 'quotaAutoResume.enabled must be a boolean'),
    ],
    ['bunny.enabled', (value) => validateBoolean(value, 'bunny.enabled must be a boolean')],
    ['bunny', (value, field) => validateBunnyConfigRecord(requireConfigRecord(field, value))],
    [
        'nextStepBox.enabled',
        (value) => validateBoolean(value, 'nextStepBox.enabled must be a boolean'),
    ],
    ['advisor.enabled', (value) => validateBoolean(value, 'advisor.enabled must be a boolean')],
    [
        'pluginRecommendation.enabled',
        (value) => validateBoolean(value, 'pluginRecommendation.enabled must be a boolean'),
    ],
    ['pluginRecommendation.dismissedPlugins', (value) => validateDismissedPlugins(value)],
    [
        'pluginRecommendation',
        (value, field) => validatePluginRecommendationConfigRecord(requireConfigRecord(field, value)),
    ],
    ['askUser', (value, field) => validateAskUserConfigRecord(requireConfigRecord(field, value))],
    [
        'promptSuggestion',
        (value, field) => validateEnabledOnlyConfigRecord(field, requireConfigRecord(field, value)),
    ],
    [
        'quotaAutoResume',
        (value, field) => validateEnabledOnlyConfigRecord(field, requireConfigRecord(field, value)),
    ],
    [
        'nextStepBox',
        (value, field) => validateEnabledOnlyConfigRecord(field, requireConfigRecord(field, value)),
    ],
    [
        'advisor',
        (value, field) => validateEnabledOnlyConfigRecord(field, requireConfigRecord(field, value)),
    ],
    ['subagent.maxConcurrentPerSession', (value) => validateSubagentMaxConcurrentPerSession(value)],
    ['subagent', (value, field) => validateSubagentConfigRecord(requireConfigRecord(field, value))],
    [
        'mergeRequests.createAsDraft',
        (value) => validateBoolean(value, 'mergeRequests.createAsDraft must be a boolean'),
    ],
    ['mergeRequests.githubMergeMethod', (value) => validateGithubMergeMethod(value)],
    ['productionParity', (value) => validateBoolean(value, 'productionParity must be a boolean')],
]);
export function validateLocalConfigValue(field, value) {
    if (field.startsWith('permission'))
        return validatePermissionConfigValue(field, value);
    if (ASK_USER_POLICY_FIELDS.has(field))
        return validateAskUserPolicyValue(field, value);
    const validate = LOCAL_CONFIG_VALUE_VALIDATORS.get(field);
    return validate ? validate(value, field) : value;
}
function validateBoolean(value, message) {
    if (typeof value === 'boolean')
        return value;
    throw new LocalConfigValidationError(message);
}
function requireConfigRecord(field, value) {
    if (isPlainRecord(value))
        return value;
    throw new LocalConfigValidationError(`Invalid ${field} config`);
}
function validateModelVariant(value) {
    if (typeof value === 'string')
        return value;
    throw new LocalConfigValidationError(`Invalid defaultModelVariant "${String(value)}"`);
}
function validateDataContributionConfigRecord(value) {
    return validateEnabledOnlyConfigRecord('dataContribution', value);
}
/** Sections that hold only the user's `enabled` choice (dataContribution, promptSuggestion, nextStepBox, advisor). */
export function validateEnabledOnlyConfigRecord(field, value) {
    const invalidKey = Object.keys(value).find((key) => key !== 'enabled');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "${field}.${invalidKey}"`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'enabled')) {
        return {
            enabled: validateBoolean(value.enabled, `Invalid ${field}.enabled "${String(value.enabled)}"`),
        };
    }
    return {};
}
/** The Bunny beta switch only stores the user's explicit `enabled` choice. */
export function validateBunnyConfigRecord(value) {
    const invalidKey = Object.keys(value).find((key) => key !== 'enabled');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "bunny.${invalidKey}"`);
    }
    return Object.prototype.hasOwnProperty.call(value, 'enabled')
        ? { enabled: validateBoolean(value.enabled, 'bunny.enabled must be a boolean') }
        : {};
}
export function validatePluginRecommendationConfigRecord(value) {
    const invalidKey = Object.keys(value).find((key) => key !== 'enabled' && key !== 'dismissedPlugins');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "pluginRecommendation.${invalidKey}"`);
    }
    const next = {};
    if (Object.prototype.hasOwnProperty.call(value, 'enabled')) {
        next.enabled = validateBoolean(value.enabled, 'pluginRecommendation.enabled must be a boolean');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dismissedPlugins')) {
        next.dismissedPlugins = validateDismissedPlugins(value.dismissedPlugins);
    }
    return next;
}
/** Canonical plugin names, at most 200; duplicates collapse keeping first order. */
function validateDismissedPlugins(value) {
    if (!Array.isArray(value) || value.length > PLUGIN_RECOMMENDATION_DISMISSED_MAX) {
        throw new LocalConfigValidationError(`pluginRecommendation.dismissedPlugins must be an array of at most ${PLUGIN_RECOMMENDATION_DISMISSED_MAX} plugin names`);
    }
    const invalid = value.find((name) => !isPluginRecommendationPluginName(name));
    if (invalid !== undefined) {
        throw new LocalConfigValidationError(`Invalid pluginRecommendation.dismissedPlugins entry "${String(invalid)}"`);
    }
    return [...new Set(value)];
}
/**
 * 只接受三个策略字段，并逐项校验取值。非法值直接报错而不是回落默认值：
 * 写入方（设置页）拿到明确错误，config.yaml 里不会落下读取时才被静默丢弃的值。
 */
export function validateAskUserConfigRecord(value) {
    const invalidKey = Object.keys(value).find((key) => !ASK_USER_POLICY_FIELDS.has(`askUser.${key}`));
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "askUser.${invalidKey}"`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, policy]) => [
        key,
        validateAskUserPolicyValue(`askUser.${key}`, policy),
    ]));
}
// `follow` 只对 Goal / Plan 有意义；默认策略本身不能“跟随”自己。
function validateAskUserPolicyValue(field, value) {
    if (field === 'askUser.defaultPolicy' ? isAskUserPolicy(value) : isAskUserContextPolicy(value)) {
        return value;
    }
    throw new LocalConfigValidationError(`Invalid ${field} "${String(value)}"`);
}
// Runtime reads fall back to the default for invalid values; writes reject them
// so config.yaml never stores a limit that would silently be ignored.
export function validateSubagentConfigRecord(value) {
    const invalidKey = Object.keys(value).find((key) => key !== 'maxConcurrentPerSession');
    if (invalidKey) {
        throw new LocalConfigValidationError(`Local runtime cannot update config field "subagent.${invalidKey}"`);
    }
    return Object.prototype.hasOwnProperty.call(value, 'maxConcurrentPerSession')
        ? {
            maxConcurrentPerSession: validateSubagentMaxConcurrentPerSession(value.maxConcurrentPerSession),
        }
        : {};
}
function validateWorktreeKeepCount(value) {
    if (isWorktreeKeepCount(value))
        return value;
    throw new LocalConfigValidationError(`Invalid worktreeKeepCount "${String(value)}": expected a positive integer`);
}
function validateSubagentMaxConcurrentPerSession(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return value;
    throw new LocalConfigValidationError(`Invalid subagent.maxConcurrentPerSession "${String(value)}": expected a positive integer`);
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
// GitLab follows each merge request's own settings, so only GitHub has a preferred method.
function validateGithubMergeMethod(value) {
    if (value === 'squash' || value === 'merge' || value === 'rebase')
        return value;
    throw new LocalConfigValidationError(`Invalid mergeRequests.githubMergeMethod "${String(value)}"`);
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