import { MAX_MODEL_MENU_TOOLTIP_LENGTH, MAX_MODEL_MENU_ROWS } from "./model-menu-limits";
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isValidEffort(effort) {
    return Boolean(isPlainObject(effort) &&
        Array.isArray(effort.options) &&
        effort.options.length > 0 &&
        effort.options.every((option) => typeof option === 'string' && option.length > 0) &&
        new Set(effort.options).size === effort.options.length &&
        (effort.value === undefined || effort.options.includes(effort.value)));
}
function isValidContext(context) {
    if (!isPlainObject(context) || !Array.isArray(context.options))
        return false;
    const { options, value, hints } = context;
    return (options.length > 0 &&
        options.every((option) => Number.isFinite(option) && option > 0) &&
        new Set(options).size === options.length &&
        (value === undefined || (Number.isFinite(value) && value > 0)) &&
        (hints === undefined ||
            (isPlainObject(hints) && Object.values(hints).every((hint) => hint === 'higher_usage'))));
}
function isValidAdvisorModel(model) {
    return (isPlainObject(model) &&
        typeof model.key === 'string' &&
        model.key.length > 0 &&
        typeof model.label === 'string' &&
        (model.group === undefined || typeof model.group === 'string') &&
        typeof model.selected === 'boolean' &&
        (model.access === undefined || model.access === 'limited' || model.access === 'upgrade') &&
        (model.description === undefined || typeof model.description === 'string') &&
        (model.tooltip === undefined ||
            (typeof model.tooltip === 'string' &&
                model.tooltip.length <= MAX_MODEL_MENU_TOOLTIP_LENGTH)) &&
        (model.effort === undefined || isValidEffort(model.effort)) &&
        (model.context === undefined || isValidContext(model.context)));
}
/**
 * The advisor row and side menu, of the card or of the list: unique model keys, parameters whose
 * current value is one of their options, and at most one checked model, none while "None" is
 * checked. Text, levels and windows are limited only by the presentation size, like the model rows
 * and the card.
 */
export function isValidModelMenuAdvisor(advisor) {
    if (!isPlainObject(advisor) ||
        (advisor.detail !== undefined && typeof advisor.detail !== 'string') ||
        (advisor.access !== undefined &&
            advisor.access !== 'limited' &&
            advisor.access !== 'upgrade') ||
        typeof advisor.off !== 'boolean' ||
        typeof advisor.disabled !== 'boolean' ||
        !Array.isArray(advisor.models) ||
        // The advisor lists the same catalog as the model rows.
        advisor.models.length > MAX_MODEL_MENU_ROWS ||
        !advisor.models.every(isValidAdvisorModel)) {
        return false;
    }
    const keys = new Set(advisor.models.map((model) => model.key));
    const checked = advisor.models.filter((model) => model.selected).length;
    return keys.size === advisor.models.length && checked <= (advisor.off ? 0 : 1);
}
export function isAdvisorAction(action) {
    return (action.type === 'advisor-select' ||
        action.type === 'advisor-effort' ||
        action.type === 'advisor-context');
}
/**
 * Advisor picks name only what the advisor side menu lists: "None", a listed model, or one of that
 * model's effort levels or windows. An Upgrade model cannot be picked. A menu that takes no picks
 * (saving, frozen) refuses all.
 */
export function isAdvisorActionAllowed(data, action) {
    const advisor = data.kind === undefined ? data.advisor : undefined;
    if (!advisor || advisor.disabled)
        return false;
    if (action.type === 'advisor-select' && action.key === null)
        return true;
    const model = typeof action.key === 'string'
        ? advisor.models.find((item) => item.key === action.key)
        : undefined;
    if (!model || model.access === 'upgrade')
        return false;
    if (action.type === 'advisor-select')
        return true;
    if (action.type === 'advisor-effort') {
        return Boolean(model.effort &&
            typeof action.value === 'string' &&
            model.effort.options.includes(action.value));
    }
    return Boolean(model.context &&
        typeof action.value === 'number' &&
        model.context.options.includes(action.value));
}
/** An Upgrade model of the advisor list opens its upgrade, like an Upgrade row of the model list. */
export function isAdvisorUpgradeAllowed(data, key) {
    const advisor = data.kind === undefined ? data.advisor : undefined;
    return Boolean(advisor &&
        !advisor.disabled &&
        advisor.models.some((model) => model.key === key && model.access === 'upgrade'));
}
