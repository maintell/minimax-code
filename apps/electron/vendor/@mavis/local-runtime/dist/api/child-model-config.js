export function resolveChildModelSelection(input) {
    const taskModel = normalizeModelConfigId(input.taskModelConfigId);
    const teamDefault = normalizeModelConfigId(input.teamDefaultModelConfigId);
    const parentModel = normalizeModelConfigId(input.parentEffectiveModel);
    const effectiveModel = taskModel ?? teamDefault ?? parentModel;
    if (!effectiveModel)
        return {};
    const inheritedVariant = effectiveModel === parentModel ? (input.parentEffectiveModelVariant ?? undefined) : undefined;
    return {
        effectiveModel,
        ...(inheritedVariant ? { effectiveModelVariant: inheritedVariant } : {}),
    };
}
function normalizeModelConfigId(value) {
    const normalized = value?.trim();
    return normalized || undefined;
}
//# sourceMappingURL=child-model-config.js.map