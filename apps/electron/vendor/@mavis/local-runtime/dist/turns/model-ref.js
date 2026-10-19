// Model-config → IModelRef capability assembly. Kept as a leaf module (no
// local-runtime imports beyond types and the openplatform patcher constants)
// so both turns/agent-model-config and runtime/model-resolver can consume it
// without import cycles.
import { ThinkingLevel, ThinkingMode } from '@mavis/protocol';
import { OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, } from '../runtime/openplatform-thinking-patcher.js';
import { normalizeLocalFileApiCapabilities } from '../runtime/file-api-capabilities.js';
import { SELECTED_THINKING_EFFORT_CAPABILITY, } from '../model-provider/model-selection.js';
import { normalizeModelThinkingEffort, normalizeModelThinkingEffortOptions, resolveModelThinkingMiddleEffort, } from '../model-provider/thinking.js';
const THINKING_VARIANT = 'thinking';
const NONE_THINKING_VARIANT = '';
const APOLLO_NONE_THINKING_VARIANT = 'none-thinking';
/**
 * Build a capability-complete IModelRef for a concrete model config. The
 * config may be undefined (unknown model): thinking collapses to OFF and
 * capabilities to text-only, mirroring the historical defaults.
 */
export function modelRefForModel(provider, modelId, modelConfig, variant, thinking, implicitCustomProviderThinking = false) {
    const selectedEffort = resolveEffectiveThinkingEffort(modelConfig, thinking);
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    if (selectedEffort) {
        capabilities[SELECTED_THINKING_EFFORT_CAPABILITY] = selectedEffort;
    }
    return {
        provider,
        model_id: modelId,
        thinking_level: resolveThinkingLevel(modelConfig, variant, implicitCustomProviderThinking),
        capabilities,
        ...modelLimitsFromConfig(modelConfig),
    };
}
/**
 * A session records only an explicit user choice. A new session resolves the
 * managed default effort when present, otherwise to the historical midpoint.
 */
export function resolveEffectiveThinkingEffort(modelConfig, thinking) {
    const availableEfforts = normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions);
    const selectedEffort = normalizeModelThinkingEffort(thinking?.effort);
    if (selectedEffort && availableEfforts?.includes(selectedEffort))
        return selectedEffort;
    const defaultEffort = normalizeModelThinkingEffort(modelConfig?.thinking?.defaultEffort);
    if (defaultEffort && availableEfforts?.includes(defaultEffort))
        return defaultEffort;
    return resolveModelThinkingMiddleEffort(availableEfforts);
}
export function capabilitiesFromModelConfig(modelConfig) {
    const input = modelConfig?.modalities?.input ?? [];
    // Two providers stamp multimodal capability in different places: open-platform
    // configs emit it via `modalities.input` (the source `turns/agent-model-config.ts`
    // reads), older registry configs stamp `capabilities.support_*` flags
    // directly. Channel adapters (WeChat / Telegram inbound) rely on this flag
    // to gate image/video downloads, so accept BOTH sources — falling back to the
    // explicit `capabilities.support_*` keeps inbound media flowing for the
    // older config shape. See test/unit/local-wechat-multimodal.test.ts.
    const capabilities = {
        support_image: input.includes('image') || modelConfig?.capabilities?.support_image === true,
        support_video: input.includes('video') || modelConfig?.capabilities?.support_video === true,
        ...normalizeLocalFileApiCapabilities(modelConfig?.capabilities),
        ...normalizeLocalMultimodalLimitCapabilities(modelConfig?.capabilities),
    };
    const mode = modelConfig?.thinking_config?.mode;
    if (mode === 'forced_on') {
        capabilities.thinking_mode = ThinkingMode.FORCED_ON;
    }
    else if (mode === 'switchable') {
        capabilities.thinking_mode = ThinkingMode.SWITCHABLE;
    }
    const openPlatformThinkingVariants = openPlatformThinkingVariantsFromModelConfig(modelConfig);
    if (openPlatformThinkingVariants) {
        capabilities[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY] =
            openPlatformThinkingVariants;
    }
    return capabilities;
}
function normalizeLocalMultimodalLimitCapabilities(capabilities) {
    const maxImage = normalizePositiveByteLimit(capabilities?.max_image_bytes_inline);
    const maxVideo = normalizePositiveByteLimit(capabilities?.max_video_bytes_inline);
    const maxBody = normalizePositiveByteLimit(capabilities?.max_request_body_bytes);
    const maxCount = normalizePositiveCountLimit(capabilities?.max_attachments_count);
    return {
        ...(maxImage !== undefined ? { max_image_bytes_inline: maxImage } : {}),
        ...(maxVideo !== undefined ? { max_video_bytes_inline: maxVideo } : {}),
        ...(maxBody !== undefined ? { max_request_body_bytes: maxBody } : {}),
        ...(maxCount !== undefined ? { max_attachments_count: maxCount } : {}),
    };
}
function normalizePositiveByteLimit(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) && value > 0 ? value : undefined;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? trimmed : undefined;
}
function normalizePositiveCountLimit(value) {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value.trim())
            : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readOpenPlatformThinkingPayload(value) {
    if (!isRecord(value))
        return undefined;
    if (value.disabled === true)
        return undefined;
    const thinking = value.thinking;
    if (!isRecord(thinking))
        return undefined;
    return { ...thinking };
}
function openPlatformThinkingVariantsFromModelConfig(modelConfig) {
    const variants = modelConfig?.variants;
    if (!variants)
        return undefined;
    const thinking = readOpenPlatformThinkingPayload(variants[THINKING_VARIANT]);
    const noneThinking = readOpenPlatformThinkingPayload(variants[APOLLO_NONE_THINKING_VARIANT]);
    if (!thinking && !noneThinking)
        return undefined;
    return {
        ...(thinking ? { thinking } : {}),
        ...(noneThinking ? { [APOLLO_NONE_THINKING_VARIANT]: noneThinking } : {}),
    };
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
function normalizeThinkingVariant(value) {
    if (value === THINKING_VARIANT)
        return THINKING_VARIANT;
    if (value === NONE_THINKING_VARIANT || value === APOLLO_NONE_THINKING_VARIANT) {
        return NONE_THINKING_VARIANT;
    }
    return undefined;
}
function readSwitchableDefaultValue(modelConfig) {
    const raw = modelConfig.thinking_config?.default_value ??
        modelConfig.thinking_config?.defaultValue;
    return raw === 'true' || raw === 'false' ? raw : undefined;
}
export function resolveThinkingLevel(modelConfig, variant, implicitCustomProviderThinking = false) {
    if (!modelConfig?.thinking_config?.mode) {
        const explicitVariant = normalizeThinkingVariant(variant);
        if (explicitVariant !== undefined &&
            (implicitCustomProviderThinking || modelConfig?.reasoning === true)) {
            return explicitVariant === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
        }
        return modelConfig?.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
    }
    switch (modelConfig.thinking_config.mode) {
        case 'forced_on':
            return ThinkingLevel.MEDIUM;
        case 'forced_off':
            return ThinkingLevel.OFF;
        case 'switchable': {
            const normalized = normalizeThinkingVariant(variant) ??
                normalizeThinkingVariant(modelConfig.defaultVariant) ??
                (readSwitchableDefaultValue(modelConfig) === 'true'
                    ? THINKING_VARIANT
                    : NONE_THINKING_VARIANT);
            return normalized === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
        }
        case 'hidden':
            return modelConfig.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
        default:
            return modelConfig.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
    }
}
//# sourceMappingURL=model-ref.js.map