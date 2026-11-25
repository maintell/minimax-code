/**
 * Built-in PostToolUse hook: links the merge request an agent created.
 *
 * When a Bash command runs "glab mr create" or "gh pr create", the CLI prints
 * the new merge request's URL, and the merge request service links it to the
 * Session. The URL names the project, so the command may run in any directory
 * or pick another repository with -R. PTC runs the same after-tool hooks, so
 * bash called from run_code is covered as well.
 *
 * The hook only observes. It never rewrites the result or blocks the tool, and
 * it does not wait for the recording, which may read the platform once.
 */
import { settleInBackground } from '../../infra/async/settle.js';
import { logger } from './initialize.js';
const MERGE_REQUEST_RECORDER_ID = 'builtin:merge-request-recorder';
/** Priority 60: after the result-rewriting builtins, so it sees the final result. */
export function createMergeRequestRecorderRegistration(recorder) {
    return {
        id: MERGE_REQUEST_RECORDER_ID,
        hookEvent: 'PostToolUse',
        matcher: '^[Bb]ash$',
        priority: 60,
        timeout: 5_000,
        handler: async (input) => {
            const command = input.toolArgs['command'];
            if (typeof command !== 'string' || !command.trim())
                return;
            const output = readResultText(input.toolResult);
            settleInBackground(record(recorder, input.sessionId, command, output));
        },
    };
}
async function record(recorder, sessionId, command, output) {
    try {
        await recorder.recordCommand(sessionId, command, output);
    }
    catch (error) {
        logger.warn(`[merge-request] linking a created merge request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/** The text a tool returned: its text blocks, or the value itself when it is a string. */
function readResultText(toolResult) {
    if (typeof toolResult === 'string')
        return toolResult;
    const content = isRecord(toolResult) ? toolResult['content'] : undefined;
    if (!Array.isArray(content))
        return '';
    return content
        .flatMap((block) => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? [block['text']]
        : [])
        .join('\n');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=merge-request-recorder.js.map