import { PLUGIN_PREPARATION_READY_OPTION_ID, PLUGIN_PREPARATION_STEP_ID, } from '@mavis/shared/questionnaire';
export const PLUGIN_PREPARATION_MODE = 'plugin-preparation';
/** Inline card: never replaces the composer and has no step navigation. */
export const PLUGIN_PREPARATION_PRESENTATION = Object.freeze({
    replaceComposer: false,
    showProgress: false,
    allowBackNavigation: false,
});
/**
 * Synthetic single-step questionnaire carried by every Plugin preparation row
 * so the shared reply validator accepts `{ stepId, selectedOptionIds: ['ready'] }`.
 * The card renders from `modePayload.pluginPreparation`, not from this step.
 */
export function pluginPreparationToolInput(input) {
    return {
        title: input.title,
        steps: [
            {
                id: PLUGIN_PREPARATION_STEP_ID,
                question: input.question,
                options: [{ id: PLUGIN_PREPARATION_READY_OPTION_ID, label: 'Ready' }],
            },
        ],
    };
}
export function readPluginPreparation(record) {
    return record.request.mode === PLUGIN_PREPARATION_MODE
        ? record.request.modePayload?.pluginPreparation
        : undefined;
}
//# sourceMappingURL=plugin-preparation.js.map