export function parseMemoryModelOverride(modelName) {
    const separator = modelName.indexOf('/');
    if (separator <= 0 || separator === modelName.length - 1) {
        throw new Error('Memory model must use provider/model format');
    }
    return {
        provider_id: modelName.slice(0, separator),
        model_id: modelName.slice(separator + 1),
    };
}
//# sourceMappingURL=model-override.js.map