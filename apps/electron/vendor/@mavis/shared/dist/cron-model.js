function invalid() {
    throw new Error('Invalid scheduled task model configuration');
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return invalid();
    return value;
}
function requiredText(value) {
    if (typeof value !== 'string' || !value.trim())
        return invalid();
    return value.trim();
}
export function decodeCronModel(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return invalid();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
        return { modelKey: trimmed };
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return invalid();
    }
    const input = record(parsed);
    if (input.version !== 1)
        return invalid();
    const providerID = requiredText(input.providerID);
    const modelID = requiredText(input.modelID);
    if (providerID.includes('/'))
        return invalid();
    if (input.variant !== undefined && typeof input.variant !== 'string')
        return invalid();
    if (input.contextLimit !== undefined &&
        (typeof input.contextLimit !== 'number' ||
            !Number.isSafeInteger(input.contextLimit) ||
            input.contextLimit <= 0))
        return invalid();
    let thinking;
    if (input.thinking !== undefined) {
        const thinkingInput = record(input.thinking);
        thinking =
            thinkingInput.effort === undefined ? {} : { effort: requiredText(thinkingInput.effort) };
    }
    const selection = {
        providerID,
        modelID,
        ...(input.variant !== undefined ? { variant: input.variant } : {}),
        ...(thinking ? { thinking } : {}),
        ...(input.contextLimit !== undefined ? { contextLimit: input.contextLimit } : {}),
    };
    return { modelKey: `${providerID}/${modelID}`, selection };
}
export function encodeCronModel(selection) {
    // Validate the same wire shape at both boundaries; only supported fields are persisted.
    const decoded = decodeCronModel(JSON.stringify({ version: 1, ...selection }));
    return JSON.stringify({ version: 1, ...decoded.selection });
}
//# sourceMappingURL=cron-model.js.map