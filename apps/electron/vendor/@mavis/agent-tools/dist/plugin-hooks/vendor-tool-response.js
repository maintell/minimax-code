import { parsePatch } from 'diff';
/**
 * Non-serializable source-owned channel for exact vendor PostToolUse values.
 *
 * Tool implementations attach a value only while they still own every field
 * required by the vendor schema.  The hook bridge must not reconstruct these
 * values from model-facing text because that text may be truncated, decorated,
 * or otherwise lossy.
 */
export const PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE = Symbol.for('mavis.pluginHooks.compatibleToolResponse');
export const PLUGIN_HOOK_CODEX_TOOL_RESPONSE = Symbol.for('mavis.pluginHooks.codexToolResponse');
export function withPluginHookCompatibleToolResponse(result, response) {
    return {
        ...result,
        details: withPluginHookCompatibleToolResponseDetails(result.details, response),
    };
}
export function withPluginHookCompatibleToolResponseDetails(details, response) {
    return { ...(details ?? {}), [PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE]: response };
}
export function readPluginHookCompatibleToolResponse(result) {
    return result.details?.[PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE];
}
export function withPluginHookCodexToolResponse(result, response) {
    return {
        ...result,
        details: withPluginHookCodexToolResponseDetails(result.details, response),
    };
}
export function withPluginHookCodexToolResponseDetails(details, response) {
    return { ...(details ?? {}), [PLUGIN_HOOK_CODEX_TOOL_RESPONSE]: response };
}
export function readPluginHookCodexToolResponse(result) {
    return result.details?.[PLUGIN_HOOK_CODEX_TOOL_RESPONSE];
}
/** Attach Compatible's BashOutput only from Pi's source-owned split stream facts. */
export function withCompatibleBashToolResponseFromPiDetails(result) {
    const response = compatibleBashToolResponseFromPiDetails(result.details);
    return response ? withPluginHookCompatibleToolResponse(result, response) : result;
}
export function compatibleBashToolResponseFromPiDetails(details) {
    const processOutput = nestedRecord(details, 'processOutput');
    if (!processOutput ||
        typeof processOutput.stdout !== 'string' ||
        typeof processOutput.stderr !== 'string' ||
        typeof processOutput.interrupted !== 'boolean' ||
        processOutput.stdoutTruncated !== false ||
        processOutput.stderrTruncated !== false) {
        return undefined;
    }
    const rawOutputPath = optionalString(processOutput.rawOutputPath);
    return {
        stdout: processOutput.stdout,
        stderr: processOutput.stderr,
        interrupted: processOutput.interrupted,
        ...(rawOutputPath ? { rawOutputPath } : {}),
    };
}
/** Build Compatible's FileReadOutput from Pi's undecorated text-file facts. */
export function compatibleReadToolResponseFromPiDetails(details) {
    const file = nestedRecord(details, 'textFile');
    if (!file ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string' ||
        !nonNegativeInteger(file.numLines) ||
        !positiveInteger(file.startLine) ||
        !positiveInteger(file.totalLines) ||
        typeof file.wholeFileAutoTruncated !== 'boolean') {
        return undefined;
    }
    return {
        type: 'text',
        file: {
            filePath: file.path,
            content: file.content,
            numLines: file.numLines,
            startLine: file.startLine,
            totalLines: file.totalLines,
            ...(file.wholeFileAutoTruncated ? { truncatedByTokenCap: true } : {}),
        },
    };
}
export function withCompatibleGlobToolResponse(result, input) {
    return withPluginHookCompatibleToolResponse(result, {
        durationMs: input.durationMs,
        numFiles: input.filenames.length,
        filenames: [...input.filenames],
        truncated: input.truncated,
        totalMatches: input.totalMatches,
        countIsComplete: input.countIsComplete,
    });
}
function nestedRecord(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const nested = value[key];
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : undefined;
}
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function nonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function withCompatibleGrepToolResponse(result, input) {
    return withPluginHookCompatibleToolResponse(result, {
        mode: input.mode,
        numFiles: input.filenames.length,
        filenames: [...input.filenames],
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.numLines !== undefined ? { numLines: input.numLines } : {}),
        ...(input.numMatches !== undefined ? { numMatches: input.numMatches } : {}),
        ...(input.totalFiles !== undefined ? { totalFiles: input.totalFiles } : {}),
        appliedLimit: input.appliedLimit,
        appliedOffset: input.appliedOffset,
    });
}
export function withCompatibleEditToolResponse(result, input) {
    return withPluginHookCompatibleToolResponse(result, {
        filePath: input.filePath,
        oldString: input.oldString,
        newString: input.newString,
        originalFile: input.originalFile,
        structuredPatch: parseStructuredPatch(result.details?.patch),
        userModified: input.userModified,
        replaceAll: input.replaceAll,
    });
}
/**
 * `structuredPatch` is a required array in the Compatible file-edit response,
 * and the upstream tool already sends `[]` when its own diff gives up, so an
 * unavailable patch degrades to the empty array. Dropping the field instead
 * makes the runner skip the handler before it starts, and describing the edit
 * as one whole-file hunk pushes the payload past the runner's input limit.
 */
function parseStructuredPatch(patch) {
    if (typeof patch !== 'string')
        return [];
    let parsed;
    try {
        parsed = parsePatch(patch)[0];
    }
    catch {
        // Hook compatibility is an enhancement; malformed vendor metadata must
        // never turn a successful edit into a failed tool call.
        return [];
    }
    if (!parsed)
        return [];
    return parsed.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
    }));
}
//# sourceMappingURL=vendor-tool-response.js.map