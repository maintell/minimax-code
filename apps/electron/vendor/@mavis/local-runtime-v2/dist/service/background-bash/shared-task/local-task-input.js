import { hasConversationTaskModelSelection, normalizeConversationSessionTitle, } from '@mavis/conversation-contract';
/** Shared Task boundary for foreground and background child creation. */
export function normalizeLocalTaskInput(input) {
    if (Object.hasOwn(input, 'model_config_id')) {
        throw new Error('Task model_config_id is not supported. Use model and effort.');
    }
    const description = normalizeConversationSessionTitle(input.description);
    if (!description) {
        throw new Error('Task description must contain 1-50 Unicode characters after normalization.');
    }
    const model = normalizeTaskOverride(input.model, 'model');
    const effort = normalizeTaskOverride(input.effort, 'effort');
    return {
        ...input,
        description,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
    };
}
export function taskModelSelectionFor(input) {
    const selection = {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
    };
    return hasConversationTaskModelSelection(selection) ? selection : undefined;
}
function normalizeTaskOverride(value, field) {
    if (value === undefined)
        return undefined;
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`Task ${field} must not be blank.`);
    return normalized;
}
//# sourceMappingURL=local-task-input.js.map