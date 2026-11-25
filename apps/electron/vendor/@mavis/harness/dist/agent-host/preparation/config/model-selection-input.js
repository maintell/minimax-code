/** Validate known choices and detach them; additive metadata never changes execution. */
export function normalizeModelSelection(value) {
    if (!isRecord(value))
        throw new TypeError('Model selection must be an object');
    const selection = {
        providerId: stringField(value.providerId, true),
        modelId: stringField(value.modelId, true),
        variant: stringField(value.variant),
        reasoning: reasoningField(value.reasoning),
        contextLimit: contextField(value.contextLimit),
        thinking: thinkingField(value.thinking),
    };
    return Object.fromEntries(Object.entries(selection).filter(([, field]) => field !== undefined));
}
function stringField(value, nonEmpty = false) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
        throw new TypeError('Model selection contains an invalid string');
    }
    return value;
}
function reasoningField(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'boolean')
        throw new TypeError('Model reasoning must be boolean');
    return value;
}
function contextField(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > 2_147_483_647) {
        throw new TypeError('Model context limit must be a positive int32');
    }
    return value;
}
function thinkingField(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        throw new TypeError('Model thinking must be an object');
    const effort = stringField(value.effort);
    return effort === undefined ? {} : { effort };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=model-selection-input.js.map