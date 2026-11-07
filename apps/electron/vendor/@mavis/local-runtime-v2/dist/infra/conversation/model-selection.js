function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readOptionalString(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}
function readThinkingBudgets(value) {
    if (!isRecord(value))
        return undefined;
    const budgets = {};
    for (const key of ['minimal', 'low', 'medium', 'high']) {
        const raw = value[key];
        if (typeof raw === 'number' || typeof raw === 'string')
            budgets[key] = raw;
    }
    return Object.keys(budgets).length > 0 ? budgets : undefined;
}
/**
 * Preserve an explicitly supplied empty object: callers use `{}` to clear a
 * previous session selection without changing the selected model.
 */
export function readLocalModelThinkingSelection(value) {
    if (!isRecord(value))
        return undefined;
    const effort = readOptionalString(value.effort);
    const offBehavior = readOptionalString(value.off_behavior ?? value.offBehavior);
    const budgets = readThinkingBudgets(value.budgets);
    return {
        ...(effort ? { effort } : {}),
        ...(offBehavior ? { off_behavior: offBehavior } : {}),
        ...(budgets ? { budgets } : {}),
    };
}
/** Session storage uses null for an explicit clear instead of persisting an empty object. */
export function readPersistedLocalModelThinkingSelection(value) {
    const selection = readLocalModelThinkingSelection(value);
    return selection && Object.keys(selection).length > 0 ? selection : null;
}
export function readLocalModelOverride(value) {
    if (!isRecord(value))
        return undefined;
    const override = readLocalModelOverrideFields(value);
    if (Object.prototype.hasOwnProperty.call(value, 'thinking'))
        return override;
    return Object.keys(override).length > 0 ? override : undefined;
}
function readLocalModelOverrideFields(value) {
    return {
        ...readLocalModelIdentityFields(value),
        ...readLocalModelBehaviorFields(value),
    };
}
function readLocalModelIdentityFields(value) {
    const providerId = readOptionalString(value.provider_id ?? value.providerId);
    const modelId = readOptionalString(value.model_id ?? value.modelId);
    return {
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
    };
}
function readLocalModelBehaviorFields(value) {
    const variant = typeof value.variant === 'string' ? value.variant : undefined;
    const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
    const hasThinking = Object.prototype.hasOwnProperty.call(value, 'thinking');
    const thinking = hasThinking ? readLocalModelThinkingSelection(value.thinking) : undefined;
    return {
        ...(variant !== undefined ? { variant } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
    };
}
export { readOptionalString };
//# sourceMappingURL=model-selection.js.map