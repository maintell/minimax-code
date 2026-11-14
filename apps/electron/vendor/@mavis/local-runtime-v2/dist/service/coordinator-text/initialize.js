/**
 * Puts the coordinator's runtime blocks together: each takes the lines its reader text already
 * rendered and wraps them in the tags of `contracts.ts`, so a tag is written in one place.
 */
import { BUNNY_HANDOFF_CLOSE, BUNNY_HANDOFF_OPEN, BUNNY_MEMORY_TAG, MCODE_STATE_TAG, SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN, TASK_REPORT_CLOSE, TASK_REPORT_OPEN, } from './contracts.js';
/** A `<system-reminder>` around one text or the lines of one. */
export function wrapSystemReminder(body) {
    return [
        SYSTEM_REMINDER_OPEN,
        ...(typeof body === 'string' ? [body] : body),
        SYSTEM_REMINDER_CLOSE,
    ].join('\n');
}
export function mcodeStateBlock(mode, lines) {
    return [`<${MCODE_STATE_TAG} mode="${mode}">`, ...lines, `</${MCODE_STATE_TAG}>`].join('\n');
}
/** A rendered text with `lines` added at the end of its last `<mcode-state>` block. */
export function appendMcodeStateLines(content, lines) {
    if (lines.length === 0)
        return content;
    const close = content.lastIndexOf(`\n</${MCODE_STATE_TAG}>`);
    if (close < 0)
        return [content, ...lines].join('\n');
    return `${content.slice(0, close)}\n${lines.join('\n')}${content.slice(close)}`;
}
export function taskReportBlock(lines) {
    return [TASK_REPORT_OPEN, ...lines, TASK_REPORT_CLOSE].join('\n');
}
export function bunnyHandoffBlock(lines) {
    return [BUNNY_HANDOFF_OPEN, ...lines, BUNNY_HANDOFF_CLOSE].join('\n');
}
export function bunnyMemoryBlock(updated, lines) {
    return [`<${BUNNY_MEMORY_TAG} updated="${updated}">`, ...lines, `</${BUNNY_MEMORY_TAG}>`].join('\n');
}
//# sourceMappingURL=initialize.js.map