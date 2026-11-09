import { writeLog } from '../../runner/ptc/ptc-observability.js';
/**
 * description stays required in the schema the model sees, so models keep
 * writing a title for the call. It only labels the call (the chat card title
 * and "from PTC: ..." on a child's approval card), so a call that leaves it
 * out, sends it blank or sends a non-string still runs its code instead of
 * failing validation: some models sent only code in most run_code calls and
 * none of those programs ran. Pi validates after prepareArguments, which puts
 * in one of these values. The user never sees them: the chat card and history
 * keep the model's own arguments, and executeRunCode passes no parent
 * description for them, so a child's approval card uses the child's own text.
 */
const DESCRIPTION_FALLBACKS = {
    missing: 'run_code call without a description',
    blank: 'run_code call with a blank description',
    non_string: 'run_code call with a non-string description',
};
/**
 * run_code's prepareArguments: returns the model's arguments unchanged unless
 * description needs a fallback.
 */
export function fillDescription(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const reason = missingDescriptionReason(args.description);
    return (reason ? { ...args, description: DESCRIPTION_FALLBACKS[reason] } : args);
}
function missingDescriptionReason(description) {
    if (description === undefined)
        return 'missing';
    if (typeof description !== 'string')
        return 'non_string';
    return description.trim() ? undefined : 'blank';
}
/**
 * The model's own description goes to child calls as their parent description.
 * A filled-in one is no title: it is only logged, and a child's approval card
 * then uses the child's own text. The log has the fields run-code-tool.ts
 * writeRunCodeEvent gives every run_code event.
 */
export function parentDescriptionOf(context, parentToolCallId, description) {
    const reason = Object.keys(DESCRIPTION_FALLBACKS).find((key) => DESCRIPTION_FALLBACKS[key] === description);
    if (!reason)
        return { parentDescription: description };
    writeLog(context.ptcLogger, 'ptc run_code description defaulted', {
        session_id: context.sessionId,
        turn_id: context.turnId,
        parent_tool_call_id: parentToolCallId,
        reason,
    });
    return {};
}
//# sourceMappingURL=run-code-description.js.map