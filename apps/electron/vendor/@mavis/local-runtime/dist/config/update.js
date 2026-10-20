import { randomBytes } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig, getConfigPath, minimaxApiModels, parseConfigText, resetConfig, serializeConfigPreservingComments, } from '@mavis/config';
import lockfile from 'proper-lockfile';
import { LocalConfigValidationError, readLocalRawConfig } from './raw-config.js';
import { assertMutableConfigField, assertSafeConfigRecord, DANGEROUS_CONFIG_PATH_SEGMENTS, isPlainRecord, validateLocalConfigValue, validateReviewConfigRecord, validateSubagentConfigRecord, } from './update-policy.js';
const LOCAL_CONFIG_WRITE_ERROR_MESSAGE = 'Local runtime failed to update config file';
const LOCAL_CONFIG_FILE_MODE = 0o600;
class LocalConfigWriteError extends Error {
    name = 'LocalConfigWriteError';
    constructor() {
        super(LOCAL_CONFIG_WRITE_ERROR_MESSAGE);
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
        return { config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        await release?.().catch(() => undefined);
    }
}
export async function compareAndSetLocalModelContext(input, beforeCommit) {
    const modelId = input.modelId.trim();
    if ((input.providerId !== 'minimax' && input.providerId !== 'minimax_api') ||
        !modelId ||
        DANGEROUS_CONFIG_PATH_SEGMENTS.has(modelId)) {
        throw new LocalConfigValidationError('Invalid MiniMax model context target');
    }
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
        if (input.providerId === 'minimax') {
            const modelContextLimits = isPlainRecord(raw.minimaxModelContextLimits)
                ? raw.minimaxModelContextLimits
                : {};
            raw.minimaxModelContextLimits = {
                ...modelContextLimits,
                [modelId]: input.contextLimit,
            };
        }
        else {
            const minimaxApi = isPlainRecord(raw.minimax_api) ? raw.minimax_api : {};
            const modelContextLimits = isPlainRecord(minimaxApi.modelContextLimits)
                ? minimaxApi.modelContextLimits
                : {};
            raw.minimax_api = {
                ...minimaxApi,
                modelContextLimits: { ...modelContextLimits, [modelId]: input.contextLimit },
            };
        }
        assertSafeConfigRecord(raw);
        await atomicWriteFile(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
        resetConfig();
        return { updated: true, config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        await release?.().catch(() => undefined);
    }
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
        const draft = {
            minimax_api: isPlainRecord(raw.minimax_api) ? raw.minimax_api : undefined,
            custom_provider: withoutEmptyEntries(isPlainRecord(raw.custom_provider) ? raw.custom_provider : undefined),
            minimaxModelSource: typeof raw.minimaxModelSource === 'string'
                ? raw.minimaxModelSource
                : undefined,
            defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
            defaultModelVariant: typeof raw.defaultModelVariant === 'string' ? raw.defaultModelVariant : undefined,
        };
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
        if (draft.minimaxModelSource) {
            raw.minimaxModelSource = draft.minimaxModelSource;
        }
        else if (draft.minimaxModelSource === undefined && 'minimaxModelSource' in raw) {
            delete raw.minimaxModelSource;
        }
        if (draft.defaultModel) {
            raw.defaultModel = draft.defaultModel;
        }
        else if (draft.defaultModel === undefined && 'defaultModel' in raw) {
            delete raw.defaultModel;
        }
        if (draft.defaultModelVariant) {
            raw.defaultModelVariant = draft.defaultModelVariant;
        }
        else if (draft.defaultModelVariant === undefined && 'defaultModelVariant' in raw) {
            delete raw.defaultModelVariant;
        }
        await atomicWriteFile(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
        resetConfig();
        return { config: getConfig() };
    }
    catch (err) {
        throw toLocalConfigError(err);
    }
    finally {
        await release?.().catch(() => undefined);
    }
}
export async function atomicWriteFile(filePath, content) {
    const tmpPath = join(dirname(filePath), `.config-tmp-${randomBytes(6).toString('hex')}`);
    let created = false;
    try {
        const mode = LOCAL_CONFIG_FILE_MODE;
        const temporary = await fs.promises.open(tmpPath, 'wx', mode);
        created = true;
        try {
            await temporary.writeFile(content, 'utf-8');
            await temporary.chmod(mode);
        }
        finally {
            await temporary.close();
        }
        await fs.promises.rename(tmpPath, filePath);
    }
    catch {
        if (created)
            await fs.promises.unlink(tmpPath).catch(() => undefined);
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
            if (field === 'review.mode' ||
                field === 'review.turnDiffCard' ||
                field === 'permission.nativeDelete' ||
                field === 'worktreeRefreshBeforeCreate' ||
                field === 'subagent.maxConcurrentPerSession') {
                throw new LocalConfigValidationError(`Unsupported config update operation for ${field}`);
            }
            const [target, key] = resolvePath(raw, field);
            const current = isPlainRecord(target[key]) ? target[key] : {};
            const patch = isPlainRecord(body.put) ? body.put : {};
            assertSafeConfigRecord(patch);
            const validatedPatch = field === 'review'
                ? validateReviewConfigRecord(patch)
                : field === 'subagent'
                    ? validateSubagentConfigRecord(patch)
                    : patch;
            target[key] = deepMergeRecord(current, validatedPatch);
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
function applyLocalConfigSet(raw, field, value) {
    assertMutableConfigField(field);
    const [target, key] = resolvePath(raw, field);
    if (field === 'defaultModelVariant' && value === null) {
        delete target[key];
        return;
    }
    target[key] = validateLocalConfigValue(field, value);
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