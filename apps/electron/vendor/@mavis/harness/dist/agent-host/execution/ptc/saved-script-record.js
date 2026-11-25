import { PTC_SCRIPT_SAVE_TOOL_NAME, ptcScriptDescriptionText } from './contracts.js';
/**
 * Records one successful `save_run_code_script` call from the after-tool hook. PTC
 * sub-calls inside `run_code` reach the same hook, so a script a program saved
 * is recorded like a direct call.
 */
export function recordSuccessfulPtcScriptSave(sink, input) {
    if (input.toolName !== PTC_SCRIPT_SAVE_TOOL_NAME || input.isError === true)
        return;
    const details = readRecord(input.details);
    const path = nonEmptyString(details.path);
    const scope = savedScope(details.scope);
    if (!path || !scope)
        return;
    const description = ptcScriptDescriptionText(nonEmptyString(readRecord(input.args).description) ?? '');
    sink.set(path, {
        path,
        scope,
        ...(description ? { description } : {}),
        overwritten: details.overwritten === true,
    });
}
/**
 * Counts one `save_run_code_script` call for this Turn's metrics. It runs from the
 * same after-tool hook as the sink above, so a direct call and a run_code
 * sub-call each count once, and a refused save counts with its own status
 * instead of being invisible. Whether the save is labelled `root` or
 * `subagent` comes from the observer, which knows the Session this Turn runs
 * in: a child Agent's save is counted once, by the child Agent's own Turn.
 */
export function observePtcScriptSave(observer, input) {
    if (!observer || input.toolName !== PTC_SCRIPT_SAVE_TOOL_NAME)
        return;
    const details = readRecord(input.details);
    // A refusal still knows which level it was aimed at, from the arguments.
    const scope = savedScope(details.scope) ?? savedScope(readRecord(input.args).scope) ?? 'unknown';
    observer.scriptSaved(scope, saveStatus(input.isError === true, details.code));
}
/**
 * The save tool's refused-overwrite code, spelled out for the same reason as
 * the tool name in contracts.ts: the orchestration core may not value-import
 * `@mavis/agent-tools`. `saved-script-record.test.ts` keeps the two equal.
 */
/** @internal Exported only for the drift test. */
export const PTC_SCRIPT_SAVE_EXISTS_CODE = 'PTC_SCRIPT_SAVE_EXISTS';
/** A refused overwrite has its own status; every other refusal is `rejected`. */
function saveStatus(failed, code) {
    if (!failed)
        return 'ok';
    return code === PTC_SCRIPT_SAVE_EXISTS_CODE ? 'exists' : 'rejected';
}
/** A saved script is only ever project-level or user-level. */
function savedScope(value) {
    return value === 'project' || value === 'user' ? value : undefined;
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function nonEmptyString(value) {
    return typeof value === 'string' && value ? value : undefined;
}
//# sourceMappingURL=saved-script-record.js.map