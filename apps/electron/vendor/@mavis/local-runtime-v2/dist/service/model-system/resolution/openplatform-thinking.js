export const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';
function getOpenPlatformThinkingVariants(modelRef) {
    const capabilities = asRecord(modelRef?.capabilities);
    const raw = asRecord(capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY]);
    if (!raw)
        return undefined;
    const thinking = cloneRecord(raw.thinking);
    const noneThinking = cloneRecord(raw['none-thinking']);
    if (!thinking && !noneThinking)
        return undefined;
    return {
        ...(thinking ? { thinking } : {}),
        ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
    };
}
export function hasOpenPlatformThinkingVariants(modelRef) {
    return getOpenPlatformThinkingVariants(modelRef) !== undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function cloneRecord(value) {
    const record = asRecord(value);
    return record ? { ...record } : undefined;
}
//# sourceMappingURL=openplatform-thinking.js.map