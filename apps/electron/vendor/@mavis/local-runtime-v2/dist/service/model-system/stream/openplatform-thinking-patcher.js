import { ThinkingLevel } from '@mavis/protocol';
import { parseProviderId } from '../resolution/model-key.js';
import { isMiniMaxM3ModelId, isMiniMaxM3ThinkingMode, resolveMiniMaxM3ThinkingProtocol, } from '../resolution/model-ref.js';
import { readSelectedThinkingEffort } from '../catalog/model-selection.js';
import { isRecord } from './payload-shape.js';
export const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';
function cloneThinkingPayload(value) {
    if (!isRecord(value))
        return undefined;
    return { ...value };
}
function patchMiniMaxM3Effort(payload, model, effort) {
    if (model.api === 'openai-responses')
        return patchMiniMaxM3Responses(payload, effort);
    if (model.api === 'openai-completions' || model.api === 'openai-chat') {
        return patchMiniMaxM3Completions(payload, effort);
    }
    if (model.api === 'anthropic-messages')
        return patchMiniMaxM3Anthropic(payload, effort);
    return undefined;
}
function patchMiniMaxM3Responses(payload, effort) {
    const patch = resolveMiniMaxM3ThinkingProtocol('openai-responses', effort);
    const reasoningPatch = isRecord(patch.reasoning) ? patch.reasoning : {};
    payload.reasoning = {
        ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
        ...reasoningPatch,
    };
    return payload;
}
function patchMiniMaxM3Completions(payload, effort) {
    if (!Array.isArray(payload.messages))
        return undefined;
    const patch = resolveMiniMaxM3ThinkingProtocol('openai-completions', effort);
    payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
    delete payload.reasoning_effort;
    return payload;
}
function patchMiniMaxM3Anthropic(payload, effort) {
    if (!Array.isArray(payload.messages))
        return undefined;
    const patch = resolveMiniMaxM3ThinkingProtocol('anthropic-messages', effort);
    payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
    const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length > 0)
        payload.output_config = outputConfig;
    else
        delete payload.output_config;
    return payload;
}
function getOpenPlatformThinkingVariants(modelRef) {
    const capabilities = modelRef?.capabilities;
    const raw = capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY];
    if (!isRecord(raw))
        return undefined;
    const thinking = cloneThinkingPayload(raw.thinking);
    const noneThinking = cloneThinkingPayload(raw['none-thinking']);
    if (!thinking && !noneThinking)
        return undefined;
    return {
        ...(thinking ? { thinking } : {}),
        ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
    };
}
export function buildOpenPlatformThinkingPatcher(modelRef) {
    const level = modelRef?.thinking_level;
    const thinkingOn = level !== undefined && level !== ThinkingLevel.OFF;
    const variants = getOpenPlatformThinkingVariants(modelRef);
    const selectedEffort = readSelectedThinkingEffort(modelRef?.capabilities);
    const miniMaxM3Effort = isMiniMaxM3ModelId(modelRef?.model_id) && isMiniMaxM3ThinkingMode(selectedEffort)
        ? selectedEffort
        : undefined;
    return function patchOpenPlatformThinking(payload, model) {
        if (!isRecord(payload))
            return undefined;
        if (miniMaxM3Effort)
            return patchMiniMaxM3Effort(payload, model, miniMaxM3Effort);
        if (!variants)
            return undefined;
        const thinking = thinkingOn ? variants.thinking : variants['none-thinking'];
        if (!thinking)
            return undefined;
        if (model.api !== 'anthropic-messages') {
            if (isMiniMaxM3ModelId(modelRef?.model_id)) {
                return patchMiniMaxM3Variant(payload, model, thinkingOn);
            }
            return undefined;
        }
        return patchMessagesApiVariant({ payload, model, thinking, thinkingOn, selectedEffort });
    };
}
function patchMiniMaxM3Variant(payload, model, thinkingOn) {
    const effort = thinkingOn ? 'on' : 'off';
    if (model.api === 'openai-responses')
        return patchMiniMaxM3Responses(payload, effort);
    if (model.api === 'openai-completions' || model.api === 'openai-chat') {
        return patchMiniMaxM3Completions(payload, effort);
    }
    return undefined;
}
function shouldPreserveProviderEffort(options) {
    if (options.configuredEffort)
        return false;
    if (parseProviderId(options.model.provider)?.source !== 'custom_provider')
        return false;
    if (typeof options.currentEffort !== 'string')
        return false;
    return Object.values(options.model.thinkingLevelMap ?? {}).includes(options.currentEffort);
}
function patchMessagesApiOutputConfig(options) {
    const { payload, model, thinkingOn, selectedEffort } = options;
    const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
    const configuredEffort = thinkingOn ? selectedEffort : undefined;
    if (configuredEffort)
        outputConfig.effort = configuredEffort;
    else if (!shouldPreserveProviderEffort({
        model,
        currentEffort: outputConfig.effort,
        configuredEffort,
    })) {
        delete outputConfig.effort;
    }
    if (Object.keys(outputConfig).length > 0)
        payload.output_config = outputConfig;
    else
        delete payload.output_config;
}
function patchMessagesApiVariant(options) {
    const { payload, thinking } = options;
    if (!Array.isArray(payload.messages))
        return undefined;
    if (thinking)
        payload.thinking = { ...thinking };
    patchMessagesApiOutputConfig(options);
    return payload;
}
//# sourceMappingURL=openplatform-thinking-patcher.js.map