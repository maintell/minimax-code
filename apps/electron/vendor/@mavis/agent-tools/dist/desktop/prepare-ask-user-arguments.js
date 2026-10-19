const TOP_LEVEL_STEP_KEYS = [
    'id',
    'header',
    'question',
    'description',
    'image',
    'options',
    'selectionMode',
    'multiSelect',
];
/**
 * Normalize legacy provider wrappers immediately before schema validation.
 * Some provider adapters wrap repeated payloads as `steps.item` /
 * `options.item`. Invalid wrappers remain untouched so validation fails closed.
 */
export function prepareAskUserArguments(args) {
    if (!isRecord(args))
        return args;
    let prepared = args;
    if (typeof prepared.question === 'string' && prepared.options !== undefined) {
        const questionnaire = { ...prepared };
        const step = {};
        for (const key of TOP_LEVEL_STEP_KEYS) {
            if (!(key in questionnaire))
                continue;
            step[key] = questionnaire[key];
            delete questionnaire[key];
        }
        questionnaire.steps = [step];
        prepared = questionnaire;
    }
    const legacySteps = unwrapLegacyItems(prepared.steps);
    const steps = legacySteps ??
        (Array.isArray(prepared.steps) && prepared.steps.every(isRecord)
            ? prepared.steps
            : isRecord(prepared.steps) && typeof prepared.steps.question === 'string'
                ? [prepared.steps]
                : undefined);
    if (steps) {
        const normalizedSteps = steps.map(normalizeLegacyAskUserStep);
        const changed = legacySteps !== undefined ||
            !Array.isArray(prepared.steps) ||
            normalizedSteps.some((step, index) => step !== steps[index]);
        if (changed) {
            prepared = {
                ...prepared,
                steps: normalizedSteps,
            };
        }
    }
    return prepared;
}
function unwrapLegacyItems(value) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !('item' in value)) {
        return undefined;
    }
    const items = Array.isArray(value.item) ? value.item : [value.item];
    return items.every(isRecord) ? items : undefined;
}
function normalizeLegacyAskUserStep(step) {
    const legacyOptions = unwrapLegacyItems(step.options);
    const options = legacyOptions ??
        (Array.isArray(step.options) && step.options.every(isRecord) ? step.options : undefined);
    const normalizedOptions = options?.map(normalizeLegacyAskUserOption);
    const selectionMode = normalizeSelectionMode(step.multiSelect);
    const optionsChanged = normalizedOptions !== undefined &&
        (legacyOptions !== undefined ||
            normalizedOptions.some((option, index) => option !== options?.[index]));
    if (!optionsChanged && selectionMode === undefined)
        return step;
    const prepared = { ...step };
    if (optionsChanged)
        prepared.options = normalizedOptions;
    if (selectionMode !== undefined) {
        if (prepared.selectionMode === undefined)
            prepared.selectionMode = selectionMode;
        delete prepared.multiSelect;
    }
    return prepared;
}
function normalizeSelectionMode(value) {
    if (value === false || value === 'false')
        return 'single';
    if (value === true || value === 'true')
        return 'multiple';
    return undefined;
}
function normalizeLegacyAskUserOption(option) {
    if (option.recommended === 'true')
        return { ...option, recommended: true };
    if (option.recommended === 'false')
        return { ...option, recommended: false };
    return option;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=prepare-ask-user-arguments.js.map