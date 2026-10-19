import { LocalModelProviderError } from '../contracts.js';
import { isModelProviderApi } from '../identity.js';
import { isMiniMaxM3ModelId, normalizeModelThinkingEffortOptions, } from '../resolution/model-ref.js';
const MASKED_KEY_MARKER = '****';
/** Absent and blank both fail: a new provider needs one usable credential source. */
export function assertValidRawApiKey(apiKey) {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
        throw new LocalModelProviderError(400, 'API key must not be empty', 'INVALID_API_KEY');
    }
    if (trimmed.includes(MASKED_KEY_MARKER)) {
        throw new LocalModelProviderError(400, 'API key looks masked; provide the raw key', 'INVALID_API_KEY');
    }
    return trimmed;
}
export function normalizeProviderCredentialUpdate(input) {
    if (input.apiKey === undefined)
        return { kind: 'keep' };
    if (input.apiKey.trim() === '')
        return { kind: 'clear' };
    return { kind: 'set', apiKey: assertValidRawApiKey(input.apiKey) };
}
/** Writes the resolved credential source onto provider options. */
export function applyProviderCredentialUpdate(options, update) {
    if (update.kind === 'set') {
        options.apiKey = update.apiKey;
        return;
    }
    if (update.kind === 'clear')
        delete options.apiKey;
}
export function normalizeApiFormat(apiFormat) {
    const trimmed = apiFormat?.trim();
    if (!trimmed)
        return undefined;
    if (!isModelProviderApi(trimmed)) {
        throw new LocalModelProviderError(400, `Unsupported api_format "${trimmed}"`, 'INVALID_API_FORMAT');
    }
    return trimmed;
}
export function normalizeHeaders(headers) {
    if (!headers)
        return undefined;
    const normalized = {};
    const seen = new Set();
    for (const [rawName, rawValue] of Object.entries(headers)) {
        const name = rawName.trim();
        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (!name || !value) {
            throw new LocalModelProviderError(400, 'Header name and value must not be empty', 'INVALID_HEADERS');
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
            throw new LocalModelProviderError(400, `Duplicate header "${name}"`, 'INVALID_HEADERS');
        }
        seen.add(key);
        normalized[name] = value;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
export function normalizeHeaderNames(names) {
    if (!names)
        return [];
    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (new Set(normalized.map((name) => name.toLowerCase())).size !== normalized.length) {
        throw new LocalModelProviderError(400, 'Duplicate header names', 'INVALID_HEADERS');
    }
    return normalized;
}
export function removeHeaderCaseInsensitive(headers, name) {
    const normalized = name.toLowerCase();
    for (const currentName of Object.keys(headers)) {
        if (currentName.toLowerCase() === normalized)
            delete headers[currentName];
    }
}
export function modelsFromInputs(models, existingModels, implicitCustomProviderThinking = false) {
    const out = {};
    for (const model of models) {
        const modelId = model.modelId?.trim();
        if (!modelId) {
            throw new LocalModelProviderError(400, 'model_id must not be empty', 'VALIDATION_ERROR');
        }
        const existing = existingModels?.[modelId];
        out[modelId] = modelFromInput(model, existing, implicitCustomProviderThinking);
    }
    return out;
}
function modelFromInput(model, existing, implicitCustomProviderThinking) {
    const effortOptions = normalizeModelThinkingEffortOptions(model.effortOptions);
    const defaultThinkingConfig = defaultThinkingConfigForInput(model, existing, effortOptions, implicitCustomProviderThinking);
    const nextModel = {
        ...existing,
        ...modelMetadataFields(model),
        ...(model.capabilities
            ? { capabilities: { ...existing?.capabilities, ...model.capabilities } }
            : {}),
        ...modelReasoningFields(model, effortOptions, defaultThinkingConfig),
        ...modelThinkingConfigFields(model, defaultThinkingConfig),
        ...modelEffortFields(effortOptions),
    };
    if (model.reasoning === false && !model.thinkingConfig?.mode) {
        delete nextModel.thinking_config;
    }
    return nextModel;
}
function defaultThinkingConfigForInput(model, existing, effortOptions, implicitCustomProviderThinking) {
    if (!implicitCustomProviderThinking)
        return undefined;
    if (model.reasoning === false || effortOptions || model.thinkingConfig?.mode)
        return undefined;
    if (existing !== undefined)
        return undefined;
    return { mode: 'switchable', default_value: 'true' };
}
function modelMetadataFields(model) {
    const fields = {};
    const configurationSource = normalizeModelConfigurationSource(model.configurationSource);
    const limit = normalizeModelLimit(model.limit);
    if (model.displayName)
        fields.name = model.displayName;
    if (configurationSource)
        fields.configuration_source = configurationSource;
    if (model.enabled !== undefined)
        fields.enabled = model.enabled;
    if (model.attachment !== undefined)
        fields.attachment = model.attachment;
    if (model.toolCall !== undefined)
        fields.tool_call = model.toolCall;
    if (model.temperature !== undefined)
        fields.temperature = model.temperature;
    if (model.modalities)
        fields.modalities = model.modalities;
    if (limit)
        fields.limit = limit;
    return fields;
}
function modelReasoningFields(model, effortOptions, defaultThinkingConfig) {
    if (model.reasoning !== undefined)
        return { reasoning: model.reasoning };
    return effortOptions || defaultThinkingConfig ? { reasoning: true } : {};
}
function modelThinkingConfigFields(model, defaultThinkingConfig) {
    if (!model.thinkingConfig?.mode) {
        return defaultThinkingConfig ? { thinking_config: defaultThinkingConfig } : {};
    }
    return {
        thinking_config: {
            mode: model.thinkingConfig.mode,
            ...(model.thinkingConfig.defaultValue
                ? { default_value: model.thinkingConfig.defaultValue }
                : {}),
        },
    };
}
function modelEffortFields(effortOptions) {
    return effortOptions ? { thinking: { effortOptions } } : {};
}
function normalizeModelConfigurationSource(value) {
    if (value === undefined)
        return undefined;
    if (value === 'manual' || value === 'discovered')
        return value;
    throw new LocalModelProviderError(400, 'configuration_source must be manual or discovered', 'VALIDATION_ERROR');
}
export function mergeModelsFromInputs(existing, models, implicitCustomProviderThinking = false) {
    const normalized = modelsFromInputs(models, existing, implicitCustomProviderThinking);
    return Object.fromEntries(models.map((input) => mergeModelInput(input, existing, normalized)));
}
function mergeModelInput(input, existing, normalized) {
    const modelId = input.modelId.trim();
    const current = existing?.[modelId];
    const patch = normalized[modelId];
    if (!current || !patch)
        return [modelId, patch ?? {}];
    const merged = mergeModelConfig(current, patch);
    applyEffortOptions(merged, current, patch, input);
    applyThinkingCleanup(merged, modelId, input);
    return [modelId, merged];
}
function mergeModelConfig(current, patch) {
    return {
        ...current,
        ...patch,
        ...(patch.limit ? { limit: { ...current.limit, ...patch.limit } } : {}),
        ...(patch.modalities ? { modalities: { ...current.modalities, ...patch.modalities } } : {}),
        ...(patch.thinking_config
            ? { thinking_config: { ...current.thinking_config, ...patch.thinking_config } }
            : {}),
    };
}
function applyEffortOptions(merged, current, patch, input) {
    if (input.effortOptions === undefined)
        return;
    const thinking = { ...(current.thinking ?? {}), ...(patch.thinking ?? {}) };
    delete thinking.effort;
    if (patch.thinking?.effortOptions)
        thinking.effortOptions = patch.thinking.effortOptions;
    else
        delete thinking.effortOptions;
    delete thinking.defaultEffort;
    if (Object.keys(thinking).length > 0)
        merged.thinking = thinking;
    else
        delete merged.thinking;
}
function applyThinkingCleanup(merged, modelId, input) {
    if (input.reasoning === false && !input.thinkingConfig?.mode)
        delete merged.thinking_config;
    if (!isMiniMaxM3ModelId(modelId))
        return;
    delete merged.thinking_config;
    delete merged.variants;
}
function normalizeModelLimit(limit) {
    if (!limit)
        return undefined;
    for (const [name, value] of Object.entries(limit)) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
            throw new LocalModelProviderError(400, `Model ${name} limit must be a positive integer`, 'VALIDATION_ERROR');
        }
    }
    return {
        ...(limit.context !== undefined ? { context: limit.context } : {}),
        ...(limit.output !== undefined ? { output: limit.output } : {}),
    };
}
//# sourceMappingURL=service-input.js.map