import { isDeepStrictEqual } from 'node:util';
export class OfficialModelConfigFetchError extends Error {
    reason;
    status;
    constructor(reason, status) {
        super(reason === 'http'
            ? 'Official model config request failed'
            : 'Official model config unavailable');
        this.reason = reason;
        this.status = status;
    }
}
export function resolveOfficialModelConfigUrl(managedBaseUrl, region, buildEnv) {
    const url = new URL('/mavis/api/v1/models', managedBaseUrl);
    url.searchParams.set('region', region);
    url.searchParams.set('buildEnv', buildEnv);
    return url.toString();
}
export async function fetchOfficialModelConfig(url, fetchImpl = fetch, accessToken, routingHeaders = {}) {
    let response;
    const token = accessToken?.trim();
    try {
        response = await fetchImpl(url, {
            headers: {
                Accept: 'application/json',
                ...routingHeaders,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(10_000),
        });
    }
    catch {
        throw new OfficialModelConfigFetchError('network');
    }
    if (!response.ok)
        throw new OfficialModelConfigFetchError('http', response.status);
    return response.json();
}
/** On-demand, last-known-good refresh for the managed MiniMax model catalog. */
export class OfficialModelConfigSync {
    deps;
    expiresAt = 0;
    inFlight;
    nowMs;
    constructor(deps) {
        this.deps = deps;
        this.nowMs = deps.nowMs ?? Date.now;
    }
    refreshIfStale() {
        if (this.nowMs() < this.expiresAt)
            return Promise.resolve();
        if (this.inFlight)
            return this.inFlight;
        this.inFlight = this.refresh().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }
    async refresh() {
        const startedAt = this.nowMs();
        let version;
        try {
            const rawSnapshot = await this.deps.fetchSnapshot();
            version = safeSnapshotVersion(rawSnapshot);
            const snapshot = parseSnapshot(rawSnapshot);
            version = snapshot.version;
            for (const diagnostic of snapshot.diagnostics) {
                this.deps.logger?.warn({ event: 'official_model_parameter_invalid', ...diagnostic }, 'Ignoring invalid optional model configuration');
            }
            try {
                await this.deps.writeProvider(snapshot.provider);
            }
            catch {
                throw new Error('write');
            }
            this.expiresAt = this.nowMs() + snapshot.ttlMs;
            this.observe('success');
        }
        catch (error) {
            const reason = refreshReason(error);
            this.observe('failure', reason);
            this.deps.logger?.warn({
                event: 'official_model_config_refresh_failed',
                reason,
                ...(error instanceof OfficialModelConfigFetchError && error.status !== undefined
                    ? { status: error.status }
                    : {}),
                ...(version ? { version } : {}),
            }, 'Official model config refresh failed; retaining last-known-good config');
        }
        finally {
            this.deps.metrics?.histogram('official_model_config_refresh_duration_ms', Math.max(0, this.nowMs() - startedAt));
        }
    }
    observe(status, reason) {
        this.deps.metrics?.counter('official_model_config_refresh_total', 1, {
            status,
            ...(reason ? { reason } : {}),
        });
    }
}
function safeSnapshotVersion(value) {
    if (!isRecord(value) || typeof value.version !== 'string')
        return undefined;
    const version = value.version.trim();
    return version || undefined;
}
function parseSnapshot(value) {
    const root = requireRecord(value, 'response');
    const version = requireNonEmptyString(root.version, 'version');
    const ttlSeconds = requirePositiveInteger(root.ttlSeconds, 'ttlSeconds');
    if (!Array.isArray(root.providers))
        throw new Error('providers');
    const minimax = root.providers.find((provider) => isRecord(provider) && provider.providerId === 'minimax');
    if (!minimax)
        throw new Error('minimax_provider');
    const config = requireRecord(minimax.config, 'minimax_config');
    const models = requireRecord(config.models, 'minimax_models');
    if (Object.keys(models).length === 0)
        throw new Error('minimax_models');
    const canonicalModels = {};
    const diagnostics = [];
    for (const [modelId, rawModel] of Object.entries(models)) {
        if (!modelId.trim())
            throw new Error('model_id');
        canonicalModels[modelId] = parseModel(rawModel, (field) => diagnostics.push({ model_id: modelId, field }));
    }
    const provider = structuredClone(config);
    provider.models = canonicalModels;
    if (config.model_order !== undefined &&
        (!Array.isArray(config.model_order) ||
            !config.model_order.every((modelId) => typeof modelId === 'string'))) {
        delete provider.model_order;
    }
    return { version, ttlMs: ttlSeconds * 1_000, provider, diagnostics };
}
function parseModel(rawValue, diagnose) {
    const raw = requireRecord(rawValue, 'model');
    const limit = raw.limit === undefined ? undefined : requireRecord(raw.limit, 'limit');
    if (limit?.context !== undefined)
        requirePositiveInteger(limit.context, 'limit.context');
    if (limit?.output !== undefined)
        requirePositiveInteger(limit.output, 'limit.output');
    const errors = {};
    const optional = (field, parse, errorKey) => {
        try {
            return parse();
        }
        catch {
            diagnose(field);
            if (errorKey)
                errors[errorKey] = true;
            return undefined;
        }
    };
    const contextOptions = optional('context_window_options', () => parsePositiveIntegerOptions(aliasValue(raw.context_window_options, raw.contextWindowOptions, 'context_options')), 'contextOptions');
    const contextOptionHints = optional('context_window_option_hints', () => parseContextWindowOptionHints(aliasValue(raw.context_window_option_hints, raw.contextWindowOptionHints, 'context_option_hints'), contextOptions));
    const thinkingConfig = raw.thinking_config === undefined
        ? undefined
        : { ...requireRecord(raw.thinking_config, 'thinking_config') };
    if (thinkingConfig) {
        const mode = thinkingConfig.mode;
        if (!['switchable', 'forced_on', 'forced_off', 'hidden'].includes(String(mode))) {
            diagnose('thinking_config.mode');
            delete thinkingConfig.mode;
        }
        const defaultValue = optional('thinking_config.default_value', () => {
            const value = aliasValue(thinkingConfig.default_value, thinkingConfig.defaultValue, 'thinking_default');
            if (value !== undefined && value !== 'true' && value !== 'false')
                throw new Error('thinking_default');
            return value;
        });
        delete thinkingConfig.defaultValue;
        delete thinkingConfig.default_value;
        if (defaultValue !== undefined)
            thinkingConfig.default_value = defaultValue;
    }
    const thinking = raw.thinking === undefined ? {} : { ...requireRecord(raw.thinking, 'thinking') };
    const effortOptions = optional('effort_options', () => {
        const value = aliasValue(raw.effort_options, thinking.effortOptions, 'effort_options');
        if (value === undefined || (Array.isArray(value) && value.length === 0))
            return undefined;
        if (!Array.isArray(value))
            throw new Error('effort_options');
        const options = value.map((item) => requireNonEmptyString(item, 'effort_options'));
        if (new Set(options).size !== options.length)
            throw new Error('effort_options');
        return options;
    }, 'effortOptions');
    const defaultEffort = errors.effortOptions
        ? undefined
        : optional('default_effort', () => {
            const value = aliasValue(raw.default_effort, thinking.defaultEffort, 'default_effort');
            if (value === undefined)
                return undefined;
            const effort = requireNonEmptyString(value, 'default_effort');
            if (effortOptions && !effortOptions.includes(effort))
                throw new Error('default_effort');
            return effort;
        });
    delete thinking.effortOptions;
    delete thinking.defaultEffort;
    if (effortOptions)
        thinking.effortOptions = effortOptions;
    if (defaultEffort)
        thinking.defaultEffort = defaultEffort;
    const model = structuredClone(raw);
    for (const field of [
        'context_window_options',
        'contextWindowOptions',
        'context_window_option_hints',
        'contextWindowOptionHints',
        'effort_options',
        'default_effort',
        'parameterErrors',
    ])
        delete model[field];
    if (thinkingConfig)
        model.thinking_config = thinkingConfig;
    if (contextOptions)
        model.contextWindowOptions = contextOptions;
    if (contextOptionHints)
        model.contextWindowOptionHints = contextOptionHints;
    if (Object.keys(thinking).length)
        model.thinking = thinking;
    else
        delete model.thinking;
    if (Object.keys(errors).length)
        model.parameterErrors = errors;
    return model;
}
function aliasValue(primary, legacy, reason) {
    if (primary !== undefined && legacy !== undefined && !isDeepStrictEqual(primary, legacy))
        throw new Error(reason);
    return primary !== undefined ? primary : legacy;
}
function parseContextWindowOptionHints(value, options) {
    if (value === undefined)
        return undefined;
    const entries = Object.entries(requireRecord(value, 'context_option_hints'));
    if (!options || entries.length === 0)
        throw new Error('context_option_hints');
    for (const [key, hint] of entries) {
        const option = Number(key);
        if (!Number.isSafeInteger(option) ||
            option <= 0 ||
            String(option) !== key ||
            !options.includes(option) ||
            hint !== 'higher_usage') {
            throw new Error('context_option_hints');
        }
    }
    return Object.fromEntries(entries);
}
function parsePositiveIntegerOptions(value) {
    if (value === undefined)
        return undefined;
    if (Array.isArray(value) && value.length === 0)
        return undefined;
    if (!Array.isArray(value))
        throw new Error('context_options');
    const options = value.map((item) => requirePositiveInteger(item, 'context_options'));
    if (new Set(options).size !== options.length)
        throw new Error('context_options');
    return options;
}
function refreshReason(error) {
    if (error instanceof OfficialModelConfigFetchError)
        return error.reason;
    return error instanceof Error && error.message === 'write' ? 'write' : 'invalid';
}
function requirePositiveInteger(value, reason) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2_147_483_647)
        throw new Error(reason);
    return Number(value);
}
function requireNonEmptyString(value, reason) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(reason);
    return value.trim();
}
function requireRecord(value, reason) {
    if (!isRecord(value))
        throw new Error(reason);
    return value;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=official-model-config-sync.js.map