import { getBucketDigit } from '@mavis/shared/rollout-bucket';
import { currentBetaResolutionContext, getRuntimeBuildEnv } from './config.js';
const defaultWarn = (message) => console.warn(`[bunny-policy] ${message}`);
/**
 * Bunny's fallback when Apollo sets no valid default: only the production
 * build starts with Bunny off. Reuses the runtime build environment (dev builds
 * map to test), the same signal the beta feature channels use. Release packages
 * are settled earlier by `getBunnyReleaseBuildDefault`.
 */
export function getBunnyBuildDefault(buildEnv = getRuntimeBuildEnv()) {
    return buildEnv !== 'prod';
}
/**
 * The fixed default of a release package, checked before Apollo `default_enabled`:
 * internal on, inside off, public prod off. Undefined for test/dev/staging packages,
 * which keep following `default_enabled`. Like the hot-update channel, the variant
 * is read before the environment: internal runs on staging and inside on prod.
 */
export function getBunnyReleaseBuildDefault(context = {}) {
    const build = context.buildEnv === undefined ||
        context.internalBuild === undefined ||
        context.insideBuild === undefined
        ? currentBetaResolutionContext()
        : undefined;
    if (context.internalBuild ?? build?.internalBuild)
        return true;
    if (context.insideBuild ?? build?.insideBuild)
        return false;
    if ((context.buildEnv ?? build?.buildEnv) === 'prod')
        return false;
    return undefined;
}
/**
 * Accepts the Apollo object (`force_disabled`, `default_enabled`,
 * `userIdHashEndNumbers`, `userIds`, `disabledUserIds`, `default_model`, `default_task_model`; the
 * two model defaults take a `"<providerId>/<modelId>"` string or an object with `model`,
 * `effort` and `context_window`).
 * A field with the wrong type is dropped as if it were not
 * configured and reported through `warn`; a malformed remote value never
 * throws. Empty lists stay empty: unlike the update grayscale, they target no one.
 */
export function parseBunnyRemotePolicy(raw, warn = defaultWarn) {
    if (raw === undefined || raw === null)
        return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warn('agent_config.bunny is not an object; ignoring it');
        return {};
    }
    const record = raw;
    const policy = {};
    const forceDisabled = record.force_disabled ?? record.forceDisabled;
    if (typeof forceDisabled === 'boolean')
        policy.forceDisabled = forceDisabled;
    else if (forceDisabled !== undefined)
        warn('force_disabled is not a boolean; ignoring it');
    const defaultEnabled = record.default_enabled ?? record.defaultEnabled;
    if (typeof defaultEnabled === 'boolean')
        policy.defaultEnabled = defaultEnabled;
    else if (defaultEnabled !== undefined)
        warn('default_enabled is not a boolean; ignoring it');
    const buckets = record.userIdHashEndNumbers ?? record.user_id_hash_end_numbers;
    if (Array.isArray(buckets) &&
        buckets.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 9)) {
        policy.userIdHashEndNumbers = [...new Set(buckets)];
    }
    else if (buckets !== undefined) {
        warn('userIdHashEndNumbers must be an array of integers 0-9; ignoring it');
    }
    const userIds = parseUserIdList(record.userIds ?? record.user_ids, 'userIds', warn);
    if (userIds)
        policy.userIds = userIds;
    const disabledUserIds = parseUserIdList(record.disabledUserIds ?? record.disabled_user_ids, 'disabledUserIds', warn);
    if (disabledUserIds)
        policy.disabledUserIds = disabledUserIds;
    const defaultModel = parseModelDefault(record.default_model ?? record.defaultModel, 'default_model', warn);
    if (defaultModel)
        policy.defaultModel = defaultModel;
    const defaultTaskModel = parseModelDefault(record.default_task_model ?? record.defaultTaskModel, 'default_task_model', warn);
    if (defaultTaskModel)
        policy.defaultTaskModel = defaultTaskModel;
    return policy;
}
/**
 * The largest context window Apollo may name, the same bound the managed model application puts on
 * a requested `context_limit` (`validateManagedContext`), so the two never disagree.
 */
const MAX_REMOTE_CONTEXT_WINDOW = 2_147_483_647;
/**
 * One model default, from either Apollo spelling: the plain `"<providerId>/<modelId>"` string, or
 * an object carrying that string as `model` plus the optional `effort` and `context_window`
 * overrides. A default without a usable model is dropped whole — the overrides are meaningless
 * without the model they belong to — while an unusable override is dropped on its own and leaves
 * the model in place, because Bunny's own effort rule and the model's own window still apply.
 */
function parseModelDefault(value, name, warn) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string') {
        const model = parseModelRef(value, name, warn);
        return model ? { model } : undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        warn(`${name} must be a "<providerId>/<modelId>" string or an object with a "model" field; ignoring it`);
        return undefined;
    }
    const record = value;
    const model = parseModelRef(record.model, name, warn);
    if (!model) {
        // `parseModelRef` stays quiet about an absent value; inside an object that is a malformed
        // default rather than an unconfigured one, and a silent drop is what the warnings exist to stop.
        if (record.model === undefined)
            warn(`${name} has no "model" field; ignoring it`);
        return undefined;
    }
    const parsed = { model };
    const effort = record.effort ?? undefined;
    if (effort !== undefined) {
        if (typeof effort === 'string' && effort.trim())
            parsed.effort = effort.trim();
        else
            warn(`${name}.effort must be a non-empty string; ignoring it`);
    }
    const contextWindow = record.context_window ?? record.contextWindow ?? undefined;
    if (contextWindow !== undefined) {
        if (Number.isSafeInteger(contextWindow) &&
            Number(contextWindow) > 0 &&
            Number(contextWindow) <= MAX_REMOTE_CONTEXT_WINDOW) {
            parsed.contextWindow = Number(contextWindow);
        }
        else {
            warn(`${name}.context_window must be a positive integer no greater than ${MAX_REMOTE_CONTEXT_WINDOW}; ignoring it`);
        }
    }
    return parsed;
}
/**
 * A `<providerId>/<modelId>` reference. Only the shape is checked here: whether the Runtime can
 * actually resolve the model is decided where it is applied, because the model catalog is not this
 * package's to read. Anything else is dropped as if it were not configured.
 */
function parseModelRef(value, name, warn) {
    if (value === undefined)
        return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const slash = trimmed.indexOf('/');
        if (slash > 0 && slash < trimmed.length - 1 && !/\s/.test(trimmed.slice(0, slash)))
            return trimmed;
    }
    warn(`${name} must be a "<providerId>/<modelId>" string; ignoring it`);
    return undefined;
}
function parseUserIdList(value, name, warn) {
    if (value === undefined)
        return undefined;
    if (Array.isArray(value) &&
        value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
        return [...new Set(value.map((item) => item.trim()))];
    }
    warn(`${name} must be an array of non-empty strings; ignoring it`);
    return undefined;
}
/** Whether Apollo targets this user through the UID allowlist or the rollout buckets. */
export function isBunnyRolloutTarget(remote, userId) {
    const id = userId?.trim();
    if (!id || !remote)
        return false;
    return (remote.userIds?.includes(id) === true ||
        remote.userIdHashEndNumbers?.includes(getBucketDigit(id)) === true);
}
/**
 * Apollo `force_disabled: true` turns Bunny off above everything, and
 * `disabledUserIds` does the same for the listed users; then an
 * explicit local choice wins; then the Apollo allowlist or bucket turns Bunny
 * on; then a release package's build variant (internal on, inside/prod off);
 * then the Apollo default; then the build environment default. A missing
 * remote policy (fetch failed) never forces Bunny off.
 */
export function resolveBunnyEnabled(explicit, remote, context = {}) {
    return resolveBunnyEnabledState(explicit, remote, context).enabled;
}
/** Same precedence as `resolveBunnyEnabled`, also naming the rule that decided it. */
export function resolveBunnyEnabledState(explicit, remote, context = {}) {
    if (remote?.forceDisabled === true)
        return { enabled: false, source: 'force_disabled' };
    const userId = context.userId?.trim();
    if (userId && remote?.disabledUserIds?.includes(userId) === true) {
        return { enabled: false, source: 'force_disabled' };
    }
    if (typeof explicit === 'boolean')
        return { enabled: explicit, source: 'local' };
    if (isBunnyRolloutTarget(remote, context.userId))
        return { enabled: true, source: 'rollout' };
    const releaseDefault = getBunnyReleaseBuildDefault(context);
    if (releaseDefault !== undefined)
        return { enabled: releaseDefault, source: 'build' };
    if (typeof remote?.defaultEnabled === 'boolean') {
        return { enabled: remote.defaultEnabled, source: 'default' };
    }
    return { enabled: getBunnyBuildDefault(context.buildEnv), source: 'build' };
}
/**
 * Fills the effective switch into a config snapshot, so the runtime and the
 * config the UI reads see one value instead of each re-deriving it.
 */
export function withEffectiveBunny(config, remote, context = {}) {
    const enabled = resolveBunnyEnabled(config.bunny?.enabled, remote, context);
    return { ...config, bunny: { ...config.bunny, enabled } };
}
/**
 * Reads the effective switch from a config snapshot. Hosts fill the value
 * through `withEffectiveBunny`; a snapshot without it predates the switch.
 */
export function isBunnyEnabledInConfig(config) {
    return config?.bunny?.enabled !== false;
}
/**
 * Whether Bunny's own memory runs: its idle timer, capture, daily lint, prompt block and
 * `remember` tool. Only an explicit `bunny.memory.enabled: true` turns it on, so a config written
 * before the switch existed, or one that never mentions it, reads as off — the same default first
 * install writes. Files already on disk stay; nothing is deleted when this is off.
 */
export function isBunnyMemoryEnabledInConfig(config) {
    return isBunnyEnabledInConfig(config) && config?.bunny?.memory?.enabled === true;
}
//# sourceMappingURL=bunny-config.js.map