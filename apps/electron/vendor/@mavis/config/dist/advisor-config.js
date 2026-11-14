/** Lenient like the other default-model fields: a malformed field is dropped on its own. */
export function parseDefaultAdvisorConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const obj = raw;
    if (typeof obj.enabled !== 'boolean')
        return undefined;
    const model = typeof obj.model === 'string' && isModelKey(obj.model) ? obj.model : undefined;
    const effort = obj.thinking !== null && typeof obj.thinking === 'object'
        ? Reflect.get(obj.thinking, 'effort')
        : undefined;
    const contextWindow = obj.contextWindow;
    return {
        enabled: obj.enabled,
        ...(model ? { model } : {}),
        ...(typeof effort === 'string' && effort.trim() ? { thinking: { effort } } : {}),
        ...(isAdvisorContextWindow(contextWindow) ? { contextWindow } : {}),
    };
}
/** `providerId/modelId`; the model id may itself contain `/`. */
export function isModelKey(value) {
    const slash = value.indexOf('/');
    return slash > 0 && slash < value.length - 1;
}
/** A positive window that fits the i32 the other default-model windows are held to. */
export function isAdvisorContextWindow(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
//# sourceMappingURL=advisor-config.js.map