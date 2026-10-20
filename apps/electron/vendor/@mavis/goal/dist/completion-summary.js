import { wrapInternalContext } from './internal-context-fragment.js';
export const DEFAULT_GOAL_COMPLETION_SUMMARY_TEMPLATE = 'The host has accepted completion of the thread goal. Deliver the final result to the user from the existing conversation evidence.';
/** The result is generated from canonical conversation context, not a synthetic tool-result message. */
export function renderCompletionSummaryPrompt(template = DEFAULT_GOAL_COMPLETION_SUMMARY_TEMPLATE) {
    return template ? wrapInternalContext('goal', template) : '';
}
//# sourceMappingURL=completion-summary.js.map