import { PTC_LIMITS, } from '../../execution/ptc/contracts.js';
import { ptcReturnTruncationNotice, truncateUtf8, utf8Bytes, } from '../../execution/ptc/return-spill.js';
/** Console output is guest text, so it never becomes host_forced_content. */
export function consoleBlock(output) {
    if (!output || (output.bytes === 0 && !output.truncated))
        return undefined;
    const text = output.text === '' || output.text.endsWith('\n') ? output.text : `${output.text}\n`;
    const note = output.truncated
        ? `[console output truncated: showing the first ${output.bytes} bytes]\n`
        : '';
    return `<ptc_console>\n${text}${note}</ptc_console>`;
}
/**
 * Host notes are kept whole; a return value that does not fit keeps its
 * beginning (children already ran, and rerunning could repeat writes) and
 * ends with a note saying how much is shown. Only when the host notes and
 * console output alone exceed the limit does delivery stay incomplete.
 */
export function buildOuterText(forced, consoleText, primary, spill) {
    const prefix = forced.join('\n');
    const forcedContent = prefix ? { forcedContent: prefix } : {};
    const leading = joinPresent([prefix, consoleText, primary.header]);
    const text = joinPresent([leading, primary.body]);
    if (utf8Bytes(text) <= PTC_LIMITS.maxOuterResultBytes)
        return { text, ...forcedContent };
    if (primary.truncatable) {
        const totalBytes = utf8Bytes(primary.body);
        const notice = (shown) => ptcReturnTruncationNotice(shown, totalBytes, spill);
        const before = leading ? `${leading}\n` : '';
        const available = PTC_LIMITS.maxOuterResultBytes - utf8Bytes(before) - utf8Bytes(`\n${notice(totalBytes)}`);
        if (available >= 0) {
            const shown = truncateUtf8(primary.body, available);
            const shownBytes = utf8Bytes(shown);
            return {
                text: `${before}${shown}\n${notice(shownBytes)}`,
                ...forcedContent,
                returnTruncated: { shownBytes, totalBytes, spilled: Boolean(spill && 'path' in spill) },
            };
        }
    }
    const marker = '\n<ptc_error code="PTC_DELIVERY_INCOMPLETE">PTC output exceeded the outer result limit. Mandatory feedback or the program return was not delivered in full.</ptc_error>';
    const markerBytes = utf8Bytes(marker);
    const incompleteContent = `${truncateUtf8(prefix, PTC_LIMITS.maxOuterResultBytes - markerBytes)}${marker}`;
    return { text: incompleteContent, forcedContent: incompleteContent, incomplete: true };
}
function joinPresent(parts) {
    return parts.filter((part) => part !== undefined && part !== '').join('\n');
}
/**
 * The `undefined` values the guest dropped from the program return value, read
 * off the completed message onto the outer result; absent when it dropped none.
 */
export function returnValueDrops(message) {
    const paths = Array.isArray(message.droppedUndefinedPaths)
        ? message.droppedUndefinedPaths.filter((path) => typeof path === 'string')
        : [];
    const count = typeof message.droppedUndefinedCount === 'number' &&
        Number.isSafeInteger(message.droppedUndefinedCount)
        ? Math.max(message.droppedUndefinedCount, paths.length)
        : paths.length;
    return count > 0 ? { droppedUndefinedPaths: paths, droppedUndefinedCount: count } : {};
}
/**
 * @internal Exported only for focused tests; callers use guestFailureHint.
 *
 * `tools.mcp__mcode-browser__group_status(...)` is valid JavaScript that reads as
 * `tools.mcp__mcode - browser__group_status(...)`, so the program fails with
 * "'browser__group_status' is not defined" and the model cannot tell why. Plugin MCP
 * servers are mostly named with "-" (mcode-browser, chrome-devtools, email-workbench), and
 * a model that had just read the plugin Skill still wrote the dot form. When a failed
 * program used dot access on such a tool name, name the bracket form in the error.
 */
export function hyphenatedToolNameHint(code, toolNames) {
    const used = [];
    for (const name of toolNames) {
        if (name.includes('-') && dotAccess(name).test(code))
            used.push(name);
    }
    if (used.length === 0)
        return undefined;
    const shown = used.slice(0, 3);
    return `A tool name containing "-" needs bracket access: JavaScript reads tools.${shown[0]} as a subtraction. Write ${shown.map((name) => `tools["${name}"]`).join(', ')} instead.`;
}
/** The hint for a program that failed inside the guest, or undefined. */
export function guestFailureHint(result, code, tools) {
    if (result.status === 'completed' || result.error?.code !== 'guest_error')
        return undefined;
    return hyphenatedToolNameHint(code, tools.map((tool) => tool.name));
}
function dotAccess(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.\\s*${escaped}(?![\\w$-])`);
}
//# sourceMappingURL=outer-result-text.js.map