import fs, { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig, getConfigPath, minimaxApiModels, parseConfigText, resetConfig, serializeConfigPreservingComments, } from '@mavis/config';
import lockfile from 'proper-lockfile';
import { writeFileAtomically } from '../file/atomic-write.js';
import { LocalConfigValidationError, readLocalRawConfig } from './raw-config.js';
import { ASK_USER_POLICY_FIELDS, assertMutableConfigField, assertSafeConfigRecord, DANGEROUS_CONFIG_PATH_SEGMENTS, isPlainRecord, validateAskUserConfigRecord, validateEnabledOnlyConfigRecord, validateBunnyConfigRecord, validateLocalConfigValue, validateReviewConfigRecord, validatePluginRecommendationConfigRecord, validateSubagentConfigRecord, } from './update-policy.js';
const LOCAL_CONFIG_WRITE_ERROR_MESSAGE = 'Local runtime failed to update config file';
const LOCAL_CONFIG_FILE_MODE = 0o600;
class LocalConfigWriteError extends Error {
    name = 'LocalConfigWriteError';
    constructor() {
        super(LOCAL_CONFIG_WRITE_ERROR_MESSAGE);
    }
}
const configUpdateListeners = new Set();
/**
 * Runs after each successful `updateLocalConfigFile` write (the Desktop
 * settings path). Model-context and BYOK writes and edits made outside the
 * runtime do not notify. Listeners must be cheap and must not throw into the
 * writer; returns the unsubscribe function.
 */
export function onLocalConfigUpdated(listener) {
    configUpdateListeners.add(listener);
    return () => configUpdateListeners.delete(listener);
}
function notifyLocalConfigUpdated() {
    for (const listener of configUpdateListeners) {
        try {
            listener();
        }
        catch {
            // A listener failure never turns a committed config write into an error.
        }
    }
}
export async function updateLocalConfigFile(body, extraMutableRoots = new Set(), preparedCommitPayload) {
    const configPath = getConfigPath();
    let release;
    try {
        await fs.promises.mkdir(dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
        await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
        release = await lockfile.lock(configPath, {
            stale: 10_000,
            retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
        });
        const originalText = readFileSync(configPath, 'utf-8');
        const raw = readLocalRawConfig(configPath);
        if (preparedCommitPayload) {
            assertSafeConfigRecord({ ...preparedCommitPayload });
            const invalidRoot = Object.keys(preparedCommitPayload).find((root) => !extraMutableRoots.has(root) || DANGEROUS_CONFIG_PATH_SEGMENTS.has(root));
            if (invalidRoot) {
                throw new LocalConfigValidationError(`Local runtime cannot update config field "${invalidRoot}"`);
            }
            Object.assign(raw, preparedCommitPayload);
        }
        else {
            applyLocalConfigUpdate(raw, body);
        }
        await atomicWriteFile(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
        resetConfig();
        notifyLocalConfigUpdated();
        return { config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        try {
            await release?.();
        }
        catch {
            // 释放锁失败不覆盖提交结果或原始错误。
        }
    }
}
export async function compareAndSetLocalModelContext(input, beforeCommit) {
    const modelId = validateModelContextTarget(input);
    const configPath = getConfigPath();
    let release;
    try {
        await fs.promises.mkdir(dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
        await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
        release = await lockfile.lock(configPath, {
            stale: 10_000,
            retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
        });
        const originalText = readFileSync(configPath, 'utf-8');
        const raw = readLocalRawConfig(configPath);
        resetConfig();
        const currentConfig = getConfig();
        const model = input.providerId === 'minimax'
            ? currentConfig.provider?.minimax?.models?.[modelId]
            : minimaxApiModels(currentConfig)[modelId];
        if (input.providerId === 'minimax_api' &&
            !model?.contextWindowOptions?.includes(input.contextLimit)) {
            throw new LocalConfigValidationError('Invalid MiniMax API context limit');
        }
        if (model?.limit?.context !== input.expectedContextLimit) {
            return { updated: false, config: currentConfig };
        }
        if (!(await beforeCommit(currentConfig))) {
            return { updated: false, config: currentConfig };
        }
        applyModelContextLimit(raw, { ...input, modelId });
        assertSafeConfigRecord(raw);
        await atomicWriteFile(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
        resetConfig();
        return { updated: true, config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        try {
            await release?.();
        }
        catch {
            // 释放锁失败不覆盖提交结果或原始错误。
        }
    }
}
function validateModelContextTarget(input) {
    const modelId = input.modelId.trim();
    if ((input.providerId !== 'minimax' && input.providerId !== 'minimax_api') ||
        !modelId ||
        DANGEROUS_CONFIG_PATH_SEGMENTS.has(modelId)) {
        throw new LocalConfigValidationError('Invalid MiniMax model context target');
    }
    return modelId;
}
function applyModelContextLimit(raw, input) {
    if (input.providerId === 'minimax') {
        const limits = isPlainRecord(raw.minimaxModelContextLimits)
            ? raw.minimaxModelContextLimits
            : {};
        raw.minimaxModelContextLimits = { ...limits, [input.modelId]: input.contextLimit };
        return;
    }
    const minimaxApi = isPlainRecord(raw.minimax_api) ? raw.minimax_api : {};
    const limits = isPlainRecord(minimaxApi.modelContextLimits) ? minimaxApi.modelContextLimits : {};
    raw.minimax_api = {
        ...minimaxApi,
        modelContextLimits: { ...limits, [input.modelId]: input.contextLimit },
    };
}
const LOCAL_BYOK_CONFIG_ROOTS = ['minimax_api', 'custom_provider'];
/**
 * Drops null/non-object entries from a BYOK subtree. A retired provider can
 * survive in config as a bare `key: null` (e.g. `oaii-oauth: null`), which is
 * not a usable provider config; keeping it would make every consumer that
 * walks the tree dereference null.
 */
function withoutEmptyEntries(subtree) {
    if (!subtree)
        return undefined;
    return Object.fromEntries(Object.entries(subtree).filter(([, value]) => isPlainRecord(value)));
}
function readByokDraft(raw) {
    return {
        minimax_api: isPlainRecord(raw.minimax_api) ? raw.minimax_api : undefined,
        custom_provider: withoutEmptyEntries(isPlainRecord(raw.custom_provider) ? raw.custom_provider : undefined),
        minimaxModelSource: typeof raw.minimaxModelSource === 'string'
            ? raw.minimaxModelSource
            : undefined,
        defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
        defaultModelVariant: typeof raw.defaultModelVariant === 'string' ? raw.defaultModelVariant : undefined,
    };
}
export async function updateLocalByokConfig(mutate) {
    const configPath = getConfigPath();
    let release;
    try {
        await fs.promises.mkdir(dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
        await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
        release = await lockfile.lock(configPath, {
            stale: 10_000,
            retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
        });
        const originalText = readFileSync(configPath, 'utf-8');
        const raw = readLocalRawConfig(configPath);
        const draft = readByokDraft(raw);
        resetConfig();
        await mutate(draft, getConfig());
        for (const root of LOCAL_BYOK_CONFIG_ROOTS) {
            const value = draft[root];
            if (value === undefined) {
                delete raw[root];
                continue;
            }
            if (!isPlainRecord(value)) {
                throw new LocalConfigValidationError(`Invalid BYOK config subtree "${root}"`);
            }
            assertSafeConfigRecord(value);
            raw[root] = value;
        }
        for (const field of ['minimaxModelSource', 'defaultModel', 'defaultModelVariant']) {
            const value = draft[field];
            if (value)
                raw[field] = value;
            else if (value === undefined)
                delete raw[field];
        }
        await atomicWriteFile(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
        resetConfig();
        return { config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        try {
            await release?.();
        }
        catch {
            // 释放锁失败不覆盖提交结果或原始错误。
        }
    }
}
/** @internal Exported only for focused tests. */
export async function atomicWriteFile(filePath, content) {
    try {
        await writeFileAtomically(filePath, content, {
            mode: LOCAL_CONFIG_FILE_MODE,
            tempPrefix: '.config-tmp-',
        });
    }
    catch {
        throw new LocalConfigWriteError();
    }
}
function applyLocalConfigUpdate(raw, body) {
    const field = typeof body.field === 'string' ? body.field : undefined;
    if (field) {
        assertMutableConfigField(field);
        if (Object.prototype.hasOwnProperty.call(body, 'set')) {
            applyLocalConfigSet(raw, field, body.set);
            if (field === 'defaultModel')
                delete raw.defaultModelVariant;
            return;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'put')) {
            applyLocalConfigPut(raw, field, body.put);
            return;
        }
        throw new LocalConfigValidationError(`Unsupported config update operation for ${field}`);
    }
    const updatesDefaultModel = Object.prototype.hasOwnProperty.call(body, 'defaultModel');
    const updatesDefaultModelVariant = Object.prototype.hasOwnProperty.call(body, 'defaultModelVariant');
    for (const [key, value] of Object.entries(body)) {
        applyLocalConfigSet(raw, key, value);
    }
    if (updatesDefaultModel && !updatesDefaultModelVariant)
        delete raw.defaultModelVariant;
}
// put 会把对象深合并到目标上；对标量叶子字段做 put 会绕过取值校验，一律拒绝。
const PUT_REJECTED_LEAF_FIELDS = new Set([
    'miniAppSuggestion.enabled',
    'productionParity',
    'review.mode',
    'review.turnDiffCard',
    'permission.nativeDelete',
    'worktreeRefreshBeforeCreate',
    'worktreeAutoCleanupEnabled',
    'worktreeKeepCount',
    'promptSuggestion.enabled',
    'quotaAutoResume.enabled',
    'nextStepBox.enabled',
    'advisor.enabled',
    'bunny.enabled',
    'pluginRecommendation.enabled',
    // Arrays are replaced with `set`; a deep-merge put would drop the list.
    'pluginRecommendation.dismissedPlugins',
    'subagent.maxConcurrentPerSession',
    'mergeRequests.createAsDraft',
    'mergeRequests.githubMergeMethod',
]);
const PUT_RECORD_VALIDATORS = new Map([
    ['review', validateReviewConfigRecord],
    ['askUser', validateAskUserConfigRecord],
    ['bunny', validateBunnyConfigRecord],
    ['subagent', validateSubagentConfigRecord],
    ['promptSuggestion', (record) => validateEnabledOnlyConfigRecord('promptSuggestion', record)],
    ['quotaAutoResume', (record) => validateEnabledOnlyConfigRecord('quotaAutoResume', record)],
    ['nextStepBox', (record) => validateEnabledOnlyConfigRecord('nextStepBox', record)],
    ['advisor', (record) => validateEnabledOnlyConfigRecord('advisor', record)],
    ['pluginRecommendation', validatePluginRecommendationConfigRecord],
]);
function applyLocalConfigPut(raw, field, value) {
    if (PUT_REJECTED_LEAF_FIELDS.has(field) || ASK_USER_POLICY_FIELDS.has(field)) {
        throw new LocalConfigValidationError(`Unsupported config update operation for ${field}`);
    }
    const [target, key] = resolvePath(raw, field);
    const current = isPlainRecord(target[key]) ? target[key] : {};
    const patch = isPlainRecord(value) ? value : {};
    assertSafeConfigRecord(patch);
    const validateRecord = PUT_RECORD_VALIDATORS.get(field);
    target[key] = deepMergeRecord(current, validateRecord ? validateRecord(patch) : patch);
}
function applyLocalConfigSet(raw, field, value) {
    assertMutableConfigField(field);
    const [target, key] = resolvePath(raw, field);
    if (field === 'defaultModelVariant' && value === null) {
        delete target[key];
        return;
    }
    const validated = validateLocalConfigValue(field, value);
    if ((field === 'askUser' || field === 'pluginRecommendation') && isPlainRecord(validated)) {
        // askUser whole-object writes may only carry the three policy fields, so
        // replacing the object would silently drop keys the user keeps in
        // config.yaml by hand (notably `enabled: false`, which hides the ask_user
        // tool). pluginRecommendation writes may carry either key alone. Merge
        // instead; the leaf values are already validated above.
        target[key] = { ...(isPlainRecord(target[key]) ? target[key] : {}), ...validated };
        return;
    }
    if (field === 'miniAppSuggestion.enabled' && validated === true && target[key] === false) {
        target.enabledSince = Date.now();
    }
    target[key] = validated;
}
function deepMergeRecord(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] =
            isPlainRecord(value) && isPlainRecord(out[key]) ? deepMergeRecord(out[key], value) : value;
    }
    return out;
}
function resolvePath(raw, field) {
    const parts = field.split('.');
    const target = parts.slice(0, -1).reduce(ensurePlainRecordChild, raw);
    return [target, parts.at(-1) ?? field];
}
function ensurePlainRecordChild(target, key) {
    const value = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
    if (isPlainRecord(value))
        return value;
    const child = {};
    target[key] = child;
    return child;
}
function toLocalConfigError(err) {
    if (err instanceof LocalConfigValidationError || err instanceof LocalConfigWriteError)
        return err;
    return new LocalConfigWriteError();
}
//# sourceMappingURL=update.js.map