import { isDefaultThinkingModelId } from '@earendil-works/pi-ai';
import { ThinkingLevel, ThinkingMode, } from '@mavis/protocol';
import { LocalModelProviderError, } from '../contracts.js';
import { CUSTOM_PROVIDER_ID_PREFIX } from '../identity.js';
import { OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, } from './openplatform-thinking.js';
import { normalizeLocalFileApiCapabilities, normalizeLocalMultimodalLimitCapabilities, } from './file-api-capabilities.js';
const THINKING_VARIANT = 'thinking';
const NONE_THINKING_VARIANT = '';
const APOLLO_NONE_THINKING_VARIANT = 'none-thinking';
const PI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const MINIMAX_M3_MODEL_ID = 'MiniMax-M3';
const SELECTED_THINKING_EFFORT_CAPABILITY = 'selected_thinking_effort';
const SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY = 'support_json_object_output';
export function modelRefForModel(provider, modelId, modelConfig, variantOrOptions) {
    const options = typeof variantOrOptions === 'string' ? { variant: variantOrOptions } : (variantOrOptions ?? {});
    if (options.managed) {
        return {
            provider,
            model_id: modelId,
            capabilities: capabilitiesFromModelConfig(modelConfig),
            ...modelLimitsFromConfig(modelConfig),
            ...resolveManagedParameters(modelConfig, options),
        };
    }
    const selectedEffort = resolveEffectiveThinkingEffort(provider, modelId, modelConfig, options);
    const capabilities = capabilitiesFromModelConfig(modelConfig) ?? {};
    if (selectedEffort) {
        Reflect.set(capabilities, SELECTED_THINKING_EFFORT_CAPABILITY, selectedEffort);
    }
    const thinkingLevel = selectedEffort
        ? thinkingLevelForEffort(selectedEffort)
        : resolveThinkingLevel(modelConfig, options.variant, options.implicitCustomProviderThinking === true);
    return {
        provider,
        model_id: modelId,
        thinking_level: thinkingLevel,
        capabilities,
        ...modelLimitsFromConfig(modelConfig),
    };
}
function invalidManagedParameter(field) {
    throw new LocalModelProviderError(400, `Invalid model ${field}`, 'VALIDATION_ERROR');
}
function resolveManagedParameters(config = {}, selection) {
    const requested = readManagedThinkingSwitch(config, selection);
    assertManagedThinkingMode(config, selection, requested.enabled);
    const enabled = requested.enabled ?? resolveThinkingLevel(config, undefined) !== ThinkingLevel.OFF;
    const effort = resolveManagedEffort(config, selection.parameterSnapshot, requested.effort, enabled);
    validateManagedContext(config, selection);
    return {
        thinking_level: enabled ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF,
        ...(effort ? { thinking_effort: effort } : {}),
        ...(selection.contextLimit !== undefined ? { context_window: selection.contextLimit } : {}),
    };
}
function requestedManagedReasoning(selection) {
    const variant = normalizeThinkingVariant(selection.variant);
    if (selection.reasoning !== undefined && typeof selection.reasoning !== 'boolean')
        invalidManagedParameter('reasoning');
    if (selection.variant !== undefined && variant === undefined)
        invalidManagedParameter('variant');
    const variantReasoning = variant === undefined ? undefined : variant === THINKING_VARIANT;
    if (selection.reasoning !== undefined &&
        variantReasoning !== undefined &&
        selection.reasoning !== variantReasoning)
        invalidManagedParameter('reasoning/variant conflict');
    return selection.reasoning ?? variantReasoning;
}
function readManagedThinkingSwitch(config, selection) {
    const enabled = requestedManagedReasoning(selection);
    const effort = selection.thinking?.effort;
    const legacy = !config.thinking?.effortOptions && config.variants;
    if (!legacy || (effort !== 'on' && effort !== 'off'))
        return { enabled, effort };
    if (enabled !== undefined && enabled !== (effort === 'on'))
        invalidManagedParameter('reasoning/effort conflict');
    return { enabled: effort === 'on', effort: undefined };
}
function assertManagedThinkingMode(config, selection, enabled) {
    if (enabled === undefined)
        return;
    switch (config.thinking_config?.mode) {
        case 'forced_on':
            if (!enabled)
                invalidManagedParameter('reasoning');
            return;
        case 'forced_off':
            if (enabled)
                invalidManagedParameter('reasoning');
            return;
        case 'switchable':
            return;
        default:
            if (!selection.parameterSnapshot)
                assertManagedLegacyVariant(config, enabled);
    }
}
function assertManagedLegacyVariant(config, enabled) {
    const variant = config.variants?.[enabled ? THINKING_VARIANT : APOLLO_NONE_THINKING_VARIANT];
    if (!variant || variant.disabled)
        invalidManagedParameter('reasoning');
}
function resolveManagedEffort(config, snapshot, effort, enabled) {
    if (effort !== undefined) {
        validateManagedEffort(config, snapshot, effort);
        return enabled ? effort : undefined;
    }
    if (!enabled || snapshot || config.parameterErrors?.effortOptions)
        return undefined;
    return config.thinking?.defaultEffort;
}
function validateManagedEffort(config, snapshot, effort) {
    if (typeof effort !== 'string' || !effort.trim() || effort !== effort.trim())
        invalidManagedParameter('thinking.effort');
    if (snapshot?.effort === 'legacy')
        return;
    if (config.parameterErrors?.effortOptions)
        invalidManagedParameter('thinking.effort');
    if (snapshot)
        return;
    const allowed = config.thinking?.effortOptions ?? fixedParameterOption(config.thinking?.defaultEffort);
    if (!allowed.includes(effort))
        invalidManagedParameter('thinking.effort');
}
function validateManagedContext(config, selection) {
    const context = selection.contextLimit;
    if (context === undefined)
        return;
    if (!Number.isSafeInteger(context) || context <= 0 || context > 2_147_483_647)
        invalidManagedParameter('context_limit');
    if (selection.parameterSnapshot?.context === 'legacy')
        return;
    if (config.parameterErrors?.contextOptions)
        invalidManagedParameter('context_limit');
    if (selection.parameterSnapshot)
        return;
    const allowed = config.contextWindowOptions ?? fixedParameterOption(config.limit?.context);
    if (!allowed.includes(context))
        invalidManagedParameter('context_limit');
}
function fixedParameterOption(value) {
    return value === undefined ? [] : [value];
}
function thinkingLevelForEffort(effort) {
    return isThinkingEffortDisabled(effort) ? ThinkingLevel.OFF : ThinkingLevel.MEDIUM;
}
/**
 * Explicit effort wins over a legacy variant. A variant without effort remains
 * authoritative for that selection; only an unqualified selection receives the
 * catalog's upper-middle default effort.
 */
function resolveEffectiveThinkingEffort(provider, modelId, modelConfig, selection) {
    const selected = normalizeModelThinkingEffort(selection.thinking?.effort);
    const thinkingMode = modelConfig?.thinking_config?.mode;
    if (thinkingMode === 'forced_off')
        return 'off';
    if (thinkingMode === 'forced_on')
        return resolveForcedOnThinkingEffort(modelConfig, selected);
    if (normalizeThinkingVariant(selection.variant) === NONE_THINKING_VARIANT)
        return undefined;
    if (!normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions)) {
        const miniMaxM3Mode = resolveMiniMaxM3ThinkingMode(provider.startsWith(CUSTOM_PROVIDER_ID_PREFIX) ? undefined : modelId, modelConfig);
        if (miniMaxM3Mode)
            return resolveMiniMaxM3SelectedEffort(miniMaxM3Mode, selected, selection);
    }
    if (thinkingMode === 'switchable' &&
        resolveThinkingLevel(modelConfig, selection.variant) === ThinkingLevel.OFF) {
        return undefined;
    }
    return resolveConfiguredThinkingEffort(modelConfig, selected, selection.variant);
}
function resolveForcedOnThinkingEffort(modelConfig, selected) {
    const options = normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions);
    if (selected && !isThinkingEffortDisabled(selected) && options?.includes(selected))
        return selected;
    const defaultEffort = normalizeModelThinkingEffort(modelConfig?.thinking?.defaultEffort);
    return defaultEffort && options?.includes(defaultEffort) ? defaultEffort : undefined;
}
function resolveMiniMaxM3SelectedEffort(mode, selected, selection) {
    if (isMiniMaxM3ThinkingMode(selected))
        return selected;
    return selection.variant === undefined ? mode : undefined;
}
function resolveConfiguredThinkingEffort(modelConfig, selected, variant) {
    if (normalizeThinkingVariant(variant) === NONE_THINKING_VARIANT)
        return undefined;
    if (isThinkingEffortDisabled(selected))
        return selected;
    const options = normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions);
    if (selected && options?.includes(selected))
        return selected;
    if (variant !== undefined)
        return undefined;
    const defaultEffort = normalizeModelThinkingEffort(modelConfig?.thinking?.defaultEffort);
    if (defaultEffort && options?.includes(defaultEffort))
        return defaultEffort;
    return options?.[Math.floor(options.length / 2)];
}
export function readSelectedThinkingEffort(capabilities) {
    return normalizeModelThinkingEffort(Reflect.get(capabilities ?? {}, SELECTED_THINKING_EFFORT_CAPABILITY));
}
/**
 * Converts the user-authored provider effort string into Pi's internal
 * reasoning level while preserving the original value in `thinkingLevelMap`.
 */
export function resolveByokThinkingProtocol(api, value, modelId) {
    const protocol = resolveModelThinkingProtocol(api, value, modelId);
    if (!protocol)
        return undefined;
    return {
        effort: protocol.effort,
        piLevel: protocol.piLevel,
        thinkingLevelMap: protocol.thinkingLevelMap,
        requestPatch: protocol.requestPatch,
        ...(protocol.enabled !== undefined ? { enabled: protocol.enabled } : {}),
        ...(protocol.forceAdaptiveThinking ? { forceAdaptiveThinking: true } : {}),
        ...(protocol.completionsThinkingFormat
            ? { completionsThinkingFormat: protocol.completionsThinkingFormat }
            : {}),
    };
}
export function isMiniMaxM3ModelId(value) {
    return (typeof value === 'string' && value.trim().toLowerCase() === MINIMAX_M3_MODEL_ID.toLowerCase());
}
export function isMiniMaxM3ThinkingMode(value) {
    return value === 'on' || value === 'off';
}
/** MiniMax M3 has a binary native Thinking control, distinct from effort levels. */
function isMiniMaxM3ThinkingSwitchable(modelId, modelConfig) {
    return isMiniMaxM3ModelId(modelId) && modelConfig?.thinking_config?.mode === 'switchable';
}
/**
 * Normalizes the catalog's switchable M3 default into the existing
 * `effectiveModelThinking.effort` wire shape. A Runtime default variant, when
 * supplied, is more specific than the catalog's own variant/default value.
 */
export function resolveMiniMaxM3ThinkingMode(modelId, modelConfig, runtimeDefaultVariant) {
    if (!modelConfig || !isMiniMaxM3ThinkingSwitchable(modelId, modelConfig))
        return undefined;
    const selected = normalizeThinkingVariant(runtimeDefaultVariant) ??
        (readSwitchableDefaultValue(modelConfig) === 'true' ? THINKING_VARIANT : NONE_THINKING_VARIANT);
    return selected === THINKING_VARIANT ? 'on' : 'off';
}
/** MiniMax M3 exposes an on/off control; Responses effort values do not change thinking depth. */
export function resolveMiniMaxM3ThinkingProtocol(api, mode) {
    if (api === 'openai-responses') {
        return { reasoning: { effort: mode === 'on' ? 'minimal' : 'none' } };
    }
    return {
        // Remove the internal on/off value serialized by Pi as a generic effort.
        ...(api === 'openai-completions' ? { reasoning_effort: undefined } : {}),
        ...(api === 'anthropic-messages' ? { output_config: { effort: undefined } } : {}),
        thinking: { type: mode === 'on' ? 'adaptive' : 'disabled' },
    };
}
export function resolveModelThinkingMiddleEffort(effortOptions) {
    if (!effortOptions?.length)
        return undefined;
    return effortOptions[Math.floor(effortOptions.length / 2)];
}
function resolveMiniMaxM3ModelThinkingProtocol(api, effort, modelId) {
    if (!isMiniMaxM3ModelId(modelId) || !isMiniMaxM3ThinkingMode(effort))
        return undefined;
    const piLevel = 'high';
    const base = {
        effort,
        enabled: effort === 'on',
        piLevel,
        thinkingLevelMap: { [piLevel]: effort },
        requestPatch: resolveMiniMaxM3ThinkingProtocol(api, effort),
    };
    if (api === 'anthropic-messages')
        return { ...base, forceAdaptiveThinking: true };
    if (api === 'openai-completions') {
        return { ...base, completionsThinkingFormat: 'openai' };
    }
    return base;
}
function resolveDisabledThinkingProtocol(api, effort) {
    if (!isThinkingEffortDisabled(effort))
        return undefined;
    const piLevel = 'high';
    const base = {
        effort,
        enabled: false,
        piLevel,
        thinkingLevelMap: { [piLevel]: effort },
    };
    if (api === 'anthropic-messages') {
        return {
            ...base,
            requestPatch: { thinking: { type: 'disabled' }, output_config: undefined },
        };
    }
    if (api === 'openai-completions') {
        return {
            ...base,
            requestPatch: { reasoning_effort: 'none' },
            completionsThinkingFormat: 'openai',
        };
    }
    return { ...base, requestPatch: { reasoning: { effort: 'none' } } };
}
export function resolveModelThinkingProtocol(api, value, modelId) {
    const effort = normalizeModelThinkingEffort(value);
    if (!effort)
        return undefined;
    const miniMaxM3Protocol = resolveMiniMaxM3ModelThinkingProtocol(api, effort, modelId);
    if (miniMaxM3Protocol)
        return miniMaxM3Protocol;
    const disabledProtocol = resolveDisabledThinkingProtocol(api, effort);
    if (disabledProtocol)
        return disabledProtocol;
    const piLevel = PI_THINKING_LEVELS.has(effort) ? effort : 'high';
    const base = {
        effort,
        piLevel,
        thinkingLevelMap: { [piLevel]: effort },
    };
    if (api === 'anthropic-messages') {
        const usesDefaultThinking = isDefaultThinkingModelId(modelId);
        return {
            ...base,
            forceAdaptiveThinking: true,
            requestPatch: {
                ...(usesDefaultThinking ? { thinking: undefined } : { thinking: { type: 'adaptive' } }),
                output_config: { effort },
            },
        };
    }
    if (api === 'openai-completions') {
        return {
            ...base,
            requestPatch: { reasoning_effort: effort },
            completionsThinkingFormat: 'openai',
        };
    }
    return {
        ...base,
        requestPatch: { reasoning: { effort } },
    };
}
export function capabilitiesFromModelConfig(modelConfig) {
    const modalities = modelConfig?.modalities?.input ?? [];
    const capabilities = {
        support_image: modalities.includes('image') || modelConfig?.capabilities?.support_image === true,
        support_video: modalities.includes('video') || modelConfig?.capabilities?.support_video === true,
        ...normalizeLocalFileApiCapabilities(modelConfig?.capabilities),
        ...normalizeLocalMultimodalLimitCapabilities(modelConfig?.capabilities),
        ...(modelConfig?.capabilities?.support_json_object_output === true
            ? { [SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY]: true }
            : {}),
    };
    const mode = modelConfig?.thinking_config?.mode;
    if (mode === 'forced_on')
        capabilities.thinking_mode = ThinkingMode.FORCED_ON;
    if (mode === 'switchable')
        capabilities.thinking_mode = ThinkingMode.SWITCHABLE;
    const variants = openPlatformThinkingVariants(modelConfig);
    if (variants) {
        Reflect.set(capabilities, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, variants);
    }
    return capabilities;
}
export function supportsJsonObjectOutput(modelRef) {
    const capabilities = modelRef.capabilities;
    return capabilities?.[SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY] === true;
}
export function modelLimitsFromConfig(modelConfig) {
    return {
        ...(typeof modelConfig?.limit?.context === 'number'
            ? { context_window: modelConfig.limit.context }
            : {}),
        ...(typeof modelConfig?.limit?.output === 'number'
            ? { max_tokens: modelConfig.limit.output }
            : {}),
    };
}
export function resolveThinkingLevel(modelConfig, variant, implicitCustomProviderThinking = false) {
    const mode = modelConfig?.thinking_config?.mode;
    if (!mode) {
        if (implicitCustomProviderThinking) {
            const explicitVariant = normalizeThinkingVariant(variant);
            if (explicitVariant !== undefined) {
                return explicitVariant === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
            }
        }
        return modelConfig?.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
    }
    if (mode === 'forced_on')
        return ThinkingLevel.MEDIUM;
    if (mode === 'forced_off')
        return ThinkingLevel.OFF;
    if (mode === 'switchable')
        return resolveSwitchableThinkingLevel(modelConfig, variant);
    return modelConfig.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
}
function resolveSwitchableThinkingLevel(modelConfig, variant) {
    const configured = normalizeThinkingVariant(variant);
    const catalogDefault = normalizeThinkingVariant(modelConfig.defaultVariant);
    const rawDefault = readSwitchableDefaultValue(modelConfig);
    const normalized = configured ??
        catalogDefault ??
        (rawDefault === 'true' ? THINKING_VARIANT : NONE_THINKING_VARIANT);
    return normalized === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
}
function openPlatformThinkingVariants(modelConfig) {
    const thinking = readThinkingPayload(modelConfig?.variants?.[THINKING_VARIANT]);
    const noneThinking = readThinkingPayload(modelConfig?.variants?.[APOLLO_NONE_THINKING_VARIANT]);
    if (!thinking && !noneThinking)
        return undefined;
    return {
        ...(thinking ? { thinking } : {}),
        ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
    };
}
function readThinkingPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    if (Reflect.get(value, 'disabled') === true)
        return undefined;
    const thinking = Reflect.get(value, 'thinking');
    return thinking && typeof thinking === 'object' && !Array.isArray(thinking)
        ? { ...thinking }
        : undefined;
}
function normalizeThinkingVariant(value) {
    if (value === THINKING_VARIANT)
        return THINKING_VARIANT;
    return value === NONE_THINKING_VARIANT || value === APOLLO_NONE_THINKING_VARIANT
        ? NONE_THINKING_VARIANT
        : undefined;
}
function readSwitchableDefaultValue(modelConfig) {
    const config = modelConfig.thinking_config;
    const raw = config?.default_value ?? config?.defaultValue;
    return raw === 'true' || raw === 'false' ? raw : undefined;
}
export function normalizeModelThinkingEffort(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function isThinkingEffortDisabled(value) {
    const effort = normalizeModelThinkingEffort(value)?.toLowerCase();
    return effort === 'none' || effort === 'off';
}
export function normalizeModelThinkingEffortOptions(value) {
    if (!Array.isArray(value))
        return undefined;
    const options = [];
    const seen = new Set();
    for (const candidate of value) {
        const option = normalizeModelThinkingEffort(candidate);
        if (!option || seen.has(option))
            continue;
        seen.add(option);
        options.push(option);
    }
    return options.length > 0 ? options : undefined;
}
//# sourceMappingURL=model-ref.js.map