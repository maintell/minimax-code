import { ptcScriptDescriptionLine } from './ptc-script-text.js';
/** Recommendation from the proposal; a task that saves more is still reported. */
const SAVED_PTC_SCRIPT_MAX_ENTRIES = 20;
const SAVED_PTC_SCRIPT_DESCRIPTION_MAX_CHARS = 120;
/** Fixed wording the parent Agent reads at the end of a task result. */
export const SAVED_PTC_SCRIPTS_USAGE = 'The subagent saved these run_code scripts during this task. Run one with run_code({ path, args, description }). Mention them to the user when you report the result.';
/**
 * Renders the `<saved-run-code-scripts>` block, or undefined when the task saved
 * nothing. Callers append it so a task without scripts reports byte-identical
 * text.
 */
export function formatSavedPtcScripts(scripts) {
    const all = scripts ?? [];
    const listed = all.slice(0, SAVED_PTC_SCRIPT_MAX_ENTRIES);
    if (listed.length === 0)
        return undefined;
    const remaining = all.length - listed.length;
    return [
        '<saved-run-code-scripts>',
        SAVED_PTC_SCRIPTS_USAGE,
        ...listed.map(savedPtcScriptLine),
        ...(remaining > 0 ? [`- ... and ${remaining} more`] : []),
        '</saved-run-code-scripts>',
    ].join('\n');
}
function savedPtcScriptLine(script) {
    const state = script.overwritten ? 'overwritten' : 'created';
    const description = script.description
        ? ptcScriptDescriptionLine(script.description, SAVED_PTC_SCRIPT_DESCRIPTION_MAX_CHARS)
        : '';
    return `- ${script.path} (${script.scope}, ${state})${description ? `: ${description}` : ''}`;
}
//# sourceMappingURL=saved-ptc-scripts.js.map