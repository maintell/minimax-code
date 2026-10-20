import { randomBytes } from 'node:crypto';
import fs, { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';
import { getConfig, getConfigPath, resetConfig } from './config.js';
import { minimaxApiModels } from './byok-config.js';
import { serializeConfigPreservingComments } from './comment-preserving-config-write.js';
import { MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID, deliveredDefaultModelId, } from './model-availability.js';
const LOCAL_CONFIG_FILE_MODE = 0o600;
const DANGEROUS_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const LOCAL_BYOK_CONFIG_ROOTS = ['minimax_api', 'custom_provider'];
/** Remove one legacy `provider.*` entry after its OAuth config moved to `custom_provider`. */
export async function removeLocalProviderConfig(providerId) {
    const normalized = providerId.trim();
    if (!normalized || normalized.includes('.') || DANGEROUS_CONFIG_PATH_SEGMENTS.has(normalized)) {
        throw new LocalModelProviderConfigValidationError('Invalid provider id');
    }
    return withLockedConfig(async (raw) => {
        if (isPlainRecord(raw.provider))
            delete raw.provider[normalized];
        return { write: true, value: undefined };
    }).then(({ config }) => ({ config }));
}
/**
 * Replace the official MiniMax snapshot without taking ownership of BYOK roots.
 *
 * A saved Runtime default that the new snapshot no longer lists is rewritten
 * in the same locked write to the delivered default, so the user stays pinned
 * to a concrete callable model. Its variant/effort/context belonged to the
 * retired model and are dropped.
 */
export async function replaceLocalManagedMinimaxProvider(provider) {
    if (!isPlainRecord(provider) || !isPlainRecord(provider.models)) {
        throw new LocalModelProviderConfigValidationError('Invalid managed MiniMax provider snapshot');
    }
    assertSafeConfigRecord(provider);
    return withLockedConfig(async (raw) => {
        raw.provider = {
            ...(isPlainRecord(raw.provider) ? raw.provider : {}),
            [MANAGED_MINIMAX_PROVIDER_ID]: structuredClone(provider),
        };
        const replacedDefaults = replaceRetiredDefaultModels(raw, provider);
        return { write: true, value: replacedDefaults };
    }).then(({ config, value }) => ({ config, replacedDefaults: value }));
}
function replaceRetiredDefaultModels(raw, provider) {
    const providerView = provider;
    const deliveredDefault = deliveredDefaultModelId(providerView);
    if (!deliveredDefault)
        return [];
    const listed = new Set(Object.entries(provider.models)
        .filter(([, model]) => !(isPlainRecord(model) && model.enabled === false))
        .map(([modelId]) => modelId));
    const replaced = [];
    for (const field of ['defaultModel', 'defaultLightModel']) {
        const value = raw[field];
        if (typeof value !== 'string')
            continue;
        const slash = value.indexOf('/');
        const providerId = slash > 0 ? value.slice(0, slash) : '';
        const modelId = value.slice(slash + 1).trim();
        if (providerId !== MANAGED_MINIMAX_PROVIDER_ID && providerId !== MINIMAX_API_PROVIDER_ID)
            continue;
        if (!modelId || listed.has(modelId))
            continue;
        const to = `${providerId}/${deliveredDefault}`;
        raw[field] = to;
        if (field === 'defaultModel') {
            delete raw.defaultModelVariant;
            delete raw.defaultModelThinking;
            delete raw.defaultModelContextWindow;
        }
        replaced.push({ field, from: value, to });
    }
    return replaced;
}
class LocalModelProviderConfigValidationError extends Error {
    name = 'LocalModelProviderConfigValidationError';
}
class LocalModelProviderConfigWriteError extends Error {
    name = 'LocalModelProviderConfigWriteError';
    constructor() {
        super('Local runtime failed to update config file');
    }
}
/**
 * Lock-protected write path for the secret-bearing BYOK trees. The generic
 * config update API deliberately cannot reach these roots.
 */
export async function updateLocalByokConfig(mutate) {
    return withLockedConfig(async (raw, currentConfig) => {
        const draft = {
            minimax_api: isPlainRecord(raw.minimax_api) ? raw.minimax_api : undefined,
            custom_provider: withoutEmptyEntries(isPlainRecord(raw.custom_provider) ? raw.custom_provider : undefined),
            minimaxModelSource: typeof raw.minimaxModelSource === 'string'
                ? raw.minimaxModelSource
                : undefined,
            defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
            defaultModelVariant: typeof raw.defaultModelVariant === 'string' ? raw.defaultModelVariant : undefined,
        };
        await mutate(draft, currentConfig);
        for (const root of LOCAL_BYOK_CONFIG_ROOTS) {
            const value = draft[root];
            if (value === undefined) {
                delete raw[root];
                continue;
            }
            if (!isPlainRecord(value)) {
                throw new LocalModelProviderConfigValidationError(`Invalid BYOK config subtree "${root}"`);
            }
            assertSafeConfigRecord(value);
            raw[root] = value;
        }
        setOptionalString(raw, 'minimaxModelSource', draft.minimaxModelSource);
        if (raw.defaultModel !== draft.defaultModel) {
            delete raw.defaultModelThinking;
            delete raw.defaultModelContextWindow;
        }
        setOptionalString(raw, 'defaultModel', draft.defaultModel);
        setOptionalString(raw, 'defaultModelVariant', draft.defaultModelVariant);
        return { write: true, value: undefined };
    }).then(({ config }) => ({ config }));
}
/** Atomically persist the default model and its optional variant. */
export async function updateLocalModelSelection(input) {
    const modelKey = input.modelKey.trim();
    if (!modelKey) {
        throw new LocalModelProviderConfigValidationError('Default model must not be empty');
    }
    if (input.contextLimit !== undefined &&
        (!Number.isSafeInteger(input.contextLimit) ||
            input.contextLimit <= 0 ||
            input.contextLimit > 2_147_483_647))
        throw new LocalModelProviderConfigValidationError('Invalid default context');
    if (input.thinking?.effort !== undefined &&
        (typeof input.thinking.effort !== 'string' || !input.thinking.effort.trim()))
        throw new LocalModelProviderConfigValidationError('Invalid default effort');
    return withLockedConfig(async (raw) => {
        raw.defaultModel = modelKey;
        if (input.contextLimit === undefined)
            delete raw.defaultModelContextWindow;
        else
            raw.defaultModelContextWindow = input.contextLimit;
        if (input.thinking?.effort === undefined)
            delete raw.defaultModelThinking;
        else
            raw.defaultModelThinking = { effort: input.thinking.effort };
        if (input.variant === undefined)
            delete raw.defaultModelVariant;
        else
            raw.defaultModelVariant = input.variant;
        return { write: true, value: undefined };
    }).then(({ config }) => ({ config }));
}
/** Compare, remote-test, and persist a managed MiniMax model Context under one config lock. */
export async function compareAndSetLocalModelContext(input, beforeCommit) {
    const modelId = input.modelId.trim();
    if ((input.providerId !== MANAGED_MINIMAX_PROVIDER_ID &&
        input.providerId !== MINIMAX_API_PROVIDER_ID) ||
        !modelId ||
        DANGEROUS_CONFIG_PATH_SEGMENTS.has(modelId)) {
        throw new LocalModelProviderConfigValidationError('Invalid MiniMax model context target');
    }
    const outcome = await withLockedConfig(async (raw, currentConfig) => {
        const model = input.providerId === MANAGED_MINIMAX_PROVIDER_ID
            ? currentConfig.provider?.[input.providerId]?.models?.[modelId]
            : minimaxApiModels(currentConfig)[modelId];
        if (input.providerId === MINIMAX_API_PROVIDER_ID &&
            !model?.contextWindowOptions?.includes(input.contextLimit)) {
            throw new LocalModelProviderConfigValidationError('Invalid MiniMax API context limit');
        }
        if (model?.limit?.context !== input.expectedContextLimit) {
            return { write: false, value: false };
        }
        if (!(await beforeCommit(currentConfig)))
            return { write: false, value: false };
        const path = input.providerId === MANAGED_MINIMAX_PROVIDER_ID
            ? ['minimaxModelContextLimits', modelId]
            : ['minimax_api', 'modelContextLimits', modelId];
        setNestedValue(raw, path, input.contextLimit);
        return { write: true, value: true };
    });
    return { config: outcome.config, updated: outcome.value };
}
async function withLockedConfig(operation) {
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
        const previousRaw = readLocalRawConfig(configPath);
        const previous = structuredClone(previousRaw);
        resetConfig();
        const outcome = await operation(previous, getConfig());
        if (outcome.write) {
            assertSafeConfigRecord(previous);
            await atomicWriteFile(configPath, serializeConfigPreservingComments(readFileSync(configPath, 'utf-8'), previousRaw, previous));
            resetConfig();
        }
        return { config: getConfig(), value: outcome.value };
    }
    catch (error) {
        if (error instanceof LocalModelProviderConfigValidationError ||
            error instanceof LocalModelProviderConfigWriteError) {
            throw error;
        }
        throw new LocalModelProviderConfigWriteError();
    }
    finally {
        await release?.().catch(() => undefined);
    }
}
async function atomicWriteFile(filePath, content) {
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
        throw new LocalModelProviderConfigWriteError();
    }
}
function readLocalRawConfig(configPath) {
    // Callers create missing files before locking. A read failure must abort the
    // update rather than turn an existing configuration into an empty document.
    const source = fs.readFileSync(configPath, 'utf-8');
    let parsed;
    try {
        parsed = yaml.load(source);
    }
    catch {
        // YAML errors include source snippets, which may contain credentials.
        throw new LocalModelProviderConfigValidationError('Invalid config.yaml: unable to parse YAML');
    }
    if (parsed == null)
        return {};
    if (!isPlainRecord(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
        throw new LocalModelProviderConfigValidationError('Invalid config.yaml: expected a YAML mapping');
    }
    return parsed;
}
function withoutEmptyEntries(subtree) {
    if (!subtree)
        return undefined;
    return Object.fromEntries(Object.entries(subtree).filter(([, value]) => isPlainRecord(value)));
}
function setOptionalString(raw, key, value) {
    if (value === undefined)
        delete raw[key];
    else
        raw[key] = value;
}
function setNestedValue(root, path, value) {
    const key = path.at(-1);
    if (!key)
        throw new LocalModelProviderConfigValidationError('Invalid config path');
    let target = root;
    for (const segment of path.slice(0, -1)) {
        if (!segment || DANGEROUS_CONFIG_PATH_SEGMENTS.has(segment)) {
            throw new LocalModelProviderConfigValidationError('Invalid config path');
        }
        const current = target[segment];
        if (isPlainRecord(current))
            target = current;
        else {
            const child = {};
            target[segment] = child;
            target = child;
        }
    }
    target[key] = value;
}
function assertSafeConfigRecord(record) {
    for (const [key, value] of Object.entries(record)) {
        if (!key || DANGEROUS_CONFIG_PATH_SEGMENTS.has(key)) {
            throw new LocalModelProviderConfigValidationError(`Local runtime cannot update config field segment "${key}"`);
        }
        if (isPlainRecord(value))
            assertSafeConfigRecord(value);
    }
}
function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=local-model-provider-write.js.map