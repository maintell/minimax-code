import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { structuredPatch } from 'diff';
import { BRAND } from '@mavis/config';
import { collectMediaOutputPaths } from './media-output-paths.js';
const MAX_TEXT_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_PATHS_PER_TOOL = 64;
const MAX_CAPTURE_TOTAL_TEXT_BYTES = MAX_TEXT_SNAPSHOT_BYTES * 2;
const SNAPSHOT_CAPTURE_CONCURRENCY = 4;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
/**
 * Number of unchanged lines to keep as context on either side of each hunk
 * so the reviewer can see *where* the change is. Matches the common
 * `git apply` / `diff -U3` default and is small enough to keep the diff
 * readable when only a single line in the middle of a long file changed.
 */
const PATCH_CONTEXT_LINES = 3;
/**
 * Upper bound on the Myers edit distance explored by jsdiff before giving up.
 * Precise diffs only matter for small, local edits — exactly the inputs where
 * Myers is fast. A near-total rewrite of a large file blows up the O(N·D)
 * search *and* produces a diff that renders as all-red/all-green anyway, so
 * past this budget we fall back to the whole-file deletion+addition hunk.
 */
const MAX_DIFF_EDIT_LENGTH = 2000;
const STRUCTURED_WRITE_TOOLS = new Set([
    'edit',
    'write',
    'multiedit',
    'multi_edit',
    'file_edit',
    'apply_patch',
    'notebookedit',
    'notebook_edit',
    'str_replace_editor',
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh']);
const SHELL_CONTROL_TOKENS = new Set(['&&', '||', ';', '|']);
const TURN_FILE_CHANGE_FILTER_DIR_NAMES = new Set([
    '.git',
    '.harness-def',
    'node_modules',
    '.next',
    'coverage',
    '.cache',
    '.turbo',
    '.vite',
    'tmp',
    '.tmp',
]);
const TURN_FILE_CHANGE_FILTER_PREFIXES = [
    '.git/',
    '.harness-def/',
    `${BRAND.APP_DIR}/plans/`,
    `${BRAND.APP_DIR}/handoffs/`,
];
/** Unclaimed tool progress observations kept per service; the oldest is evicted first. */
const DEFAULT_MAX_PENDING_TOOL_PROGRESS = 256;
export class LocalTurnFileChangeCaptureService {
    store;
    options;
    toolProgress = new Map();
    constructor(store, options) {
        this.store = store;
        this.options = options;
    }
    async begin(session, turnId) {
        this.clearToolProgress(session.sessionId);
        if (!session.workspaceDir)
            return undefined;
        await this.store.markOtherPendingTurnsFinalized(session.sessionId, turnId, 'superseded');
        await this.store.createTurn({
            turnId,
            sessionId: session.sessionId,
            agentName: session.agentName,
            workspaceDir: session.workspaceDir,
        });
        return { turnId };
    }
    async captureToolUseStart(input) {
        if (!input.toolCallId)
            return;
        const turn = await this.store.getPendingTurn(input.sessionId);
        if (!turn)
            return;
        if (input.turnId && input.turnId !== turn.turnId)
            return;
        const extracted = extractToolWritePaths(turn.workspaceDir, input.toolName, input.toolArgs);
        if (extracted.kind === 'ignore')
            return;
        if (extracted.kind === 'ambiguous') {
            await this.store.markToolCaptureAmbiguous({
                captureId: makeCaptureId(),
                turnId: turn.turnId,
                sessionId: input.sessionId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                reason: extracted.reason,
            });
            return;
        }
        const paths = limitCapturePaths(extracted.paths);
        const before = await snapshotCapturedFiles(turn.workspaceDir, paths);
        await this.store.createToolCapture({
            captureId: makeCaptureId(),
            turnId: turn.turnId,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            paths,
            before,
            ...(extracted.ambiguityReason ? { ambiguityReason: extracted.ambiguityReason } : {}),
        });
    }
    async captureToolUseFinish(input) {
        if (!input.toolCallId)
            return;
        const turn = await this.store.getPendingTurn(input.sessionId);
        if (!turn)
            return;
        if (input.turnId && input.turnId !== turn.turnId)
            return;
        const startedCapture = await this.store.getStartedToolCapture(turn.turnId, input.sessionId, input.toolCallId);
        const paths = startedCapture?.paths ?? extractFinishedCapturePaths(turn.workspaceDir, input);
        if (paths.length === 0)
            return;
        const after = await snapshotCapturedFiles(turn.workspaceDir, limitCapturePaths(paths));
        const completed = await this.store.completeToolCapture({
            turnId: turn.turnId,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            after,
        });
        if (!completed || !startedCapture)
            return;
        const observation = buildToolArtifactProgressObservation({
            ...startedCapture,
            after,
            status: 'completed',
            completedAtMs: this.options.nowMs(),
        });
        if (observation) {
            this.rememberToolProgress(toolProgressKey(input.sessionId, turn.turnId, input.toolCallId), observation);
        }
    }
    rememberToolProgress(key, observation) {
        this.toolProgress.set(key, observation);
        const limit = this.options.maxPendingToolProgress ?? DEFAULT_MAX_PENDING_TOOL_PROGRESS;
        if (this.toolProgress.size > limit) {
            const oldest = this.toolProgress.keys().next().value;
            if (oldest !== undefined)
                this.toolProgress.delete(oldest);
        }
    }
    takeToolArtifactProgress(input) {
        return input.toolCallIds.flatMap((toolCallId) => {
            const key = toolProgressKey(input.sessionId, input.turnId, toolCallId);
            const observation = this.toolProgress.get(key);
            this.toolProgress.delete(key);
            return observation ? [observation] : [];
        });
    }
    getToolCaptureHookRegistrations() {
        return [
            {
                id: 'builtin:turn-file-change-capture:PreToolUse',
                hookEvent: 'PreToolUse',
                priority: 1_000,
                timeout: 10_000,
                handler: async (input, output) => {
                    const hookInput = input;
                    const hookOutput = output;
                    await this.captureToolUseStart(toCaptureToolUseInput(hookInput, hookOutput.toolArgs ?? hookInput.toolArgs));
                },
            },
            {
                id: 'builtin:turn-file-change-capture:PostToolUse',
                hookEvent: 'PostToolUse',
                priority: 1,
                timeout: 10_000,
                handler: async (input) => {
                    const hookInput = input;
                    await this.captureToolUseFinish(toCaptureToolUseInput(hookInput, hookInput.toolArgs));
                },
            },
        ];
    }
    async finalizeLatestPending(sessionId, options = {}) {
        this.clearToolProgress(sessionId, options.turnId);
        const turn = await this.store.getPendingTurn(sessionId);
        if (!turn || !matchesRequestedTurn(turn.turnId, options.turnId)) {
            return {
                captured: false,
                reason: 'turn_not_found',
                fileChange: 'recording_failed',
                observationNotes: ['local_turn_diff_turn_not_found'],
            };
        }
        const assistantMessageId = options.assistantMessageId;
        try {
            const captures = await this.store.listCompletedToolCaptures(sessionId, turn.turnId);
            const { fileChanges, undo, undoable } = buildCapturedChanges(captures);
            const observation = buildFileChangeObservation(captures, fileChanges);
            if (!assistantMessageId) {
                await this.finishPendingTurn(sessionId, turn.turnId, 'empty');
                return {
                    ...observation,
                    captured: false,
                    reason: 'assistant_message_not_found',
                };
            }
            if (fileChanges.length === 0) {
                await this.finishPendingTurn(sessionId, turn.turnId, 'empty');
                return {
                    ...observation,
                    captured: false,
                    reason: observation.fileChange === 'uncertain' ? 'ambiguous_capture' : 'empty_diff',
                    assistantMessageId,
                };
            }
            const changeSetId = this.options.makeId('cs');
            const now = this.options.nowMs();
            await this.store.upsert({
                changeSetId,
                sessionId,
                agentName: turn.agentName,
                turnId: turn.turnId,
                assistantMessageId,
                workspaceDir: turn.workspaceDir,
                capturedAtMs: now,
                updatedAtMs: now,
                status: 'active',
                fileChanges,
                undo,
                undoable,
            });
            await this.finishPendingTurn(sessionId, turn.turnId, 'finalized');
            return {
                ...observation,
                captured: true,
                changeSetId,
                assistantMessageId,
                fileCount: fileChanges.length,
            };
        }
        catch (err) {
            try {
                await this.finishPendingTurn(sessionId, turn.turnId, 'failed');
            }
            catch {
                // Preserve the original capture failure even when finalization also fails.
            }
            const message = `local_turn_diff_finalize_failed:${err instanceof Error ? err.message : String(err)}`;
            this.options.reportFailure?.(sessionId, message);
            return {
                captured: false,
                reason: 'capture_failed',
                ...(assistantMessageId ? { assistantMessageId } : {}),
                fileChange: 'recording_failed',
                observationNotes: [message],
            };
        }
    }
    async markPendingFailed(sessionId, turnId) {
        this.clearToolProgress(sessionId, turnId);
        const turn = await this.store.getPendingTurn(sessionId);
        if (!turn)
            return;
        if (turnId && turn.turnId !== turnId)
            return;
        await this.finishPendingTurn(sessionId, turn.turnId, 'failed');
    }
    async finishPendingTurn(sessionId, turnId, status) {
        await this.store.markTurnFinalized(sessionId, turnId, status);
        await this.store.markOtherPendingTurnsFinalized(sessionId, turnId, 'superseded');
    }
    clearToolProgress(sessionId, turnId) {
        const prefix = turnId ? toolProgressKey(sessionId, turnId, '') : `${sessionId}\u0000`;
        for (const key of this.toolProgress.keys()) {
            if (key.startsWith(prefix))
                this.toolProgress.delete(key);
        }
    }
}
export async function applyLocalTurnDiffSnapshotMutation(record, action) {
    if (!record.undoable || !record.undo || record.undo.length === 0) {
        return { success: false, reason: 'not_undoable' };
    }
    const sourceKey = action === 'revert' ? 'after' : 'before';
    const targetKey = action === 'revert' ? 'before' : 'after';
    for (const undo of record.undo) {
        const current = await snapshotCapturedFile(record.workspaceDir, undo.file);
        if (snapshotHash(current) !== snapshotHash(undo[sourceKey])) {
            return { success: false, reason: 'conflict' };
        }
    }
    for (const undo of record.undo) {
        const result = await applySnapshot(record.workspaceDir, undo.file, undo[targetKey]);
        if (!result.success)
            return result;
    }
    return { success: true };
}
async function applySnapshot(workspaceDir, file, target) {
    const absolute = safeCapturedPath(workspaceDir, file);
    if (!absolute)
        return { success: false, reason: 'unsafe_path' };
    if (!target.exists) {
        await fs.rm(absolute, { force: true });
        return { success: true };
    }
    if (target.content === undefined)
        return { success: false, reason: 'not_undoable' };
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, target.content, 'utf8');
    return { success: true };
}
function makeCaptureId() {
    return `tcap_${randomUUID().replaceAll('-', '')}`;
}
function toolProgressKey(sessionId, turnId, toolCallId) {
    return `${sessionId}\u0000${turnId}\u0000${toolCallId}`;
}
function toCaptureToolUseInput(hookInput, toolArgs) {
    return {
        sessionId: hookInput.sessionId,
        agentName: hookInput.agentName,
        ...(hookInput.turnId ? { turnId: hookInput.turnId } : {}),
        toolName: hookInput.toolName,
        ...(hookInput.toolCallId ? { toolCallId: hookInput.toolCallId } : {}),
        toolArgs,
    };
}
function extractToolWritePaths(workspaceDir, toolName, toolArgs) {
    const normalizedToolName = toolName.toLowerCase().replaceAll('-', '_');
    const paths = new Set();
    // Media generators write through their declared output paths rather than the
    // Write/Shell tools. Capture both sides so new downloads and overwrites remain
    // distinguishable in the ordinary Turn diff, including asynchronous video queries.
    if (/(?:^|__)(?:image_synthesize|gen_videos|query_video_generation|batch_text_to_video|batch_image_to_video)$/u.test(normalizedToolName)) {
        return extractMediaOutputPaths(workspaceDir, toolArgs);
    }
    if (STRUCTURED_WRITE_TOOLS.has(normalizedToolName)) {
        const primaryPath = getStringArg(toolArgs, ['file_path', 'filePath', 'path']);
        const patch = getStringArg(toolArgs, ['patch', 'input', '_raw']);
        collectCapturePaths(workspaceDir, [primaryPath, ...parsePatchPaths(patch ?? '')], paths);
        return paths.size > 0 ? { kind: 'paths', paths: [...paths].sort() } : { kind: 'ignore' };
    }
    if (!SHELL_TOOLS.has(normalizedToolName))
        return { kind: 'ignore' };
    const command = getStringArg(toolArgs, ['command', 'cmd', 'script', 'input', '_raw']);
    if (!command)
        return { kind: 'ignore' };
    collectCapturePaths(workspaceDir, parsePatchPaths(command), paths);
    const tokens = shellTokenize(command);
    const ambiguous = [
        extractShellRedirectTargets(workspaceDir, tokens, paths),
        extractShellToolTargets(workspaceDir, tokens, paths),
        extractFormatterTargets(workspaceDir, tokens, paths),
    ].some(Boolean);
    if (paths.size > 0) {
        return {
            kind: 'paths',
            paths: [...paths].sort(),
            ...(ambiguous ? { ambiguityReason: 'shell_target_ambiguous' } : {}),
        };
    }
    return ambiguous ? { kind: 'ambiguous', reason: 'shell_target_ambiguous' } : { kind: 'ignore' };
}
function extractMediaOutputPaths(workspaceDir, toolArgs) {
    const paths = new Set();
    collectCapturePaths(workspaceDir, collectMediaOutputPaths(toolArgs, MAX_CAPTURE_PATHS_PER_TOOL), paths);
    // Matrix output admission is workspace-scoped. Do not inspect outside paths
    // which the generator itself would reject before downloading anything.
    const scoped = [...paths].filter((file) => !path.isAbsolute(file) && !path.win32.isAbsolute(file));
    return scoped.length > 0 ? { kind: 'paths', paths: scoped.sort() } : { kind: 'ignore' };
}
function extractFinishedCapturePaths(workspaceDir, input) {
    const extracted = extractToolWritePaths(workspaceDir, input.toolName, input.toolArgs);
    return extracted.kind === 'paths' ? extracted.paths : [];
}
function collectCapturePaths(workspaceDir, candidates, paths) {
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const relative = normalizeCapturePath(workspaceDir, candidate);
        if (relative)
            paths.add(relative);
    }
}
function getStringArg(args, keys) {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.trim())
            return value;
    }
    return undefined;
}
function parsePatchPaths(patch) {
    const paths = [];
    const patterns = [
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
        /^\+\+\+ b\/(.+)$/gm,
        /^--- a\/(.+)$/gm,
    ];
    for (const pattern of patterns) {
        for (const match of patch.matchAll(pattern)) {
            const filePath = match[1]?.trim();
            if (filePath && filePath !== '/dev/null')
                paths.push(filePath);
        }
    }
    return paths;
}
function extractShellRedirectTargets(workspaceDir, tokens, paths) {
    let ambiguous = false;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const separateRedirect = /^(?:\d+)?(?:>|>>|&>)$/.test(token);
        if (separateRedirect) {
            if (collectPathToken(workspaceDir, tokens[index + 1], paths) === 'ambiguous') {
                ambiguous = true;
            }
            index += 1;
            continue;
        }
        const attached = /^(?:\d+)?(?:>|>>|&>)(.+)$/.exec(token);
        if (attached?.[1] && collectPathToken(workspaceDir, attached[1], paths) === 'ambiguous') {
            ambiguous = true;
        }
    }
    return ambiguous;
}
function extractShellToolTargets(workspaceDir, tokens, paths) {
    let ambiguous = false;
    for (let index = 0; index < tokens.length; index += 1) {
        const command = path.basename(tokens[index]);
        const remaining = tokens.slice(index + 1);
        let result = false;
        if (command === 'tee')
            result = collectShellTargets(workspaceDir, remaining, paths);
        else if (command === 'cp' || command === 'mv') {
            result = collectCopyMoveTargets(workspaceDir, { command, tokens: remaining }, paths);
        }
        else if (command === 'sed') {
            result = collectSedTargets(workspaceDir, remaining, paths);
        }
        if (result)
            ambiguous = true;
    }
    return ambiguous;
}
function collectShellTargets(workspaceDir, tokens, paths) {
    let ambiguous = false;
    for (const target of tokens) {
        if (SHELL_CONTROL_TOKENS.has(target))
            break;
        if (target.startsWith('-'))
            continue;
        if (collectPathToken(workspaceDir, target, paths) === 'ambiguous')
            ambiguous = true;
    }
    return ambiguous;
}
function collectCopyMoveTargets(workspaceDir, input, paths) {
    const candidates = input.tokens.filter((item) => !SHELL_CONTROL_TOKENS.has(item) && !item.startsWith('-'));
    if (candidates.length !== 2)
        return candidates.length > 2;
    const sourceAmbiguous = input.command === 'mv' && collectPathToken(workspaceDir, candidates[0], paths) === 'ambiguous';
    const targetAmbiguous = collectPathToken(workspaceDir, candidates[1], paths) === 'ambiguous';
    return sourceAmbiguous || targetAmbiguous;
}
function collectSedTargets(workspaceDir, tokens, paths) {
    const editFlagIndex = tokens.findIndex((item) => item.startsWith('-i'));
    if (editFlagIndex < 0)
        return false;
    let cursor = editFlagIndex + 1;
    if (tokens[editFlagIndex] === '-i' && tokens[cursor] === '')
        cursor += 1;
    return collectShellTargets(workspaceDir, tokens.slice(cursor + 1), paths);
}
function extractFormatterTargets(workspaceDir, tokens, paths) {
    let ambiguous = false;
    const writeFlagIndex = tokens.findIndex((token) => token === '--write' || token === '--fix');
    if (writeFlagIndex < 0)
        return false;
    for (let index = writeFlagIndex + 1; index < tokens.length; index += 1) {
        const target = tokens[index];
        if (SHELL_CONTROL_TOKENS.has(target))
            break;
        if (target.startsWith('-'))
            continue;
        if (collectPathToken(workspaceDir, target, paths) === 'ambiguous')
            ambiguous = true;
    }
    return ambiguous;
}
function collectPathToken(workspaceDir, token, paths) {
    if (!token || isDiscardTarget(token))
        return 'ok';
    if (hasDynamicShellPathToken(token))
        return 'ambiguous';
    const relative = normalizeCapturePath(workspaceDir, token);
    if (!relative)
        return token === '.' || token.endsWith('/') ? 'ambiguous' : 'ok';
    paths.add(relative);
    return 'ok';
}
function normalizeCapturePath(workspaceDir, filePath) {
    const trimmed = filePath.trim();
    if (!trimmed || isDiscardTarget(trimmed))
        return undefined;
    return normalizeResolvedCapturePath(workspaceDir, normalizeMsysPath(trimmed));
}
function normalizeMsysPath(filePath) {
    if (process.platform !== 'win32')
        return filePath;
    const match = filePath.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (!match)
        return filePath;
    const drive = match[1].toUpperCase();
    const rest = match[2]?.replace(/\//g, '\\') ?? '\\';
    return `${drive}:${rest}`;
}
function matchesRequestedTurn(turnId, requested) {
    return !requested || turnId === requested;
}
function normalizeResolvedCapturePath(workspaceDir, trimmed) {
    const root = path.resolve(workspaceDir);
    const absolute = resolveCapturePath(root, trimmed);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (absolute !== root && !absolute.startsWith(prefix))
        return absolute;
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (!relative || isFilteredRelativePath(relative))
        return undefined;
    return relative;
}
function resolveCapturePath(root, filePath) {
    if (path.isAbsolute(filePath))
        return path.resolve(filePath);
    if (path.win32.isAbsolute(filePath))
        return path.win32.resolve(filePath);
    return path.resolve(root, filePath);
}
function safeCapturedPath(workspaceDir, filePath) {
    const normalized = normalizeCapturePath(workspaceDir, filePath);
    if (!normalized)
        return undefined;
    if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized))
        return normalized;
    return path.resolve(workspaceDir, normalized);
}
async function snapshotCapturedFile(workspaceDir, filePath, budget) {
    const normalized = normalizeCapturePath(workspaceDir, filePath);
    if (!normalized)
        return { file: filePath, exists: false };
    const absolute = safeCapturedPath(workspaceDir, normalized);
    if (!absolute)
        return { file: normalized, exists: false };
    try {
        const stats = await fs.stat(absolute);
        if (!stats.isFile())
            return { file: normalized, exists: false };
        const metadataEntry = {
            file: normalized,
            exists: true,
            hash: metadataSnapshotHash(stats),
            sizeBytes: stats.size,
        };
        if (stats.size > MAX_TEXT_SNAPSHOT_BYTES)
            return { ...metadataEntry, oversized: true };
        if (budget && stats.size > budget.remainingTextBytes) {
            return { ...metadataEntry, oversized: true };
        }
        if (budget)
            budget.remainingTextBytes -= stats.size;
        const buffer = await readSmallFileBuffer(absolute, stats.size);
        if (!buffer)
            return { ...metadataEntry, oversized: true };
        return snapshotBuffer(normalized, buffer);
    }
    catch {
        return { file: normalized, exists: false };
    }
}
function snapshotBuffer(file, buffer) {
    const entry = {
        file,
        exists: true,
        hash: createHash('sha256').update(buffer).digest('hex'),
        sizeBytes: buffer.length,
    };
    if (buffer.includes(0) || !isValidUtf8(buffer))
        return { ...entry, binary: true };
    return { ...entry, content: buffer.toString('utf8') };
}
function isValidUtf8(buffer) {
    try {
        FATAL_UTF8_DECODER.decode(buffer);
        return true;
    }
    catch {
        return false;
    }
}
async function snapshotCapturedFiles(workspaceDir, filePaths) {
    const budget = { remainingTextBytes: MAX_CAPTURE_TOTAL_TEXT_BYTES };
    return mapWithConcurrency(filePaths, SNAPSHOT_CAPTURE_CONCURRENCY, (filePath) => snapshotCapturedFile(workspaceDir, filePath, budget));
}
function limitCapturePaths(paths) {
    return paths.slice(0, MAX_CAPTURE_PATHS_PER_TOOL);
}
async function readSmallFileBuffer(absolute, expectedSize) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
        return undefined;
    if (expectedSize > MAX_TEXT_SNAPSHOT_BYTES)
        return undefined;
    const handle = await fs.open(absolute, 'r');
    try {
        if (expectedSize === 0)
            return Buffer.alloc(0);
        const buffer = Buffer.allocUnsafe(expectedSize);
        const { bytesRead } = await handle.read(buffer, 0, expectedSize, 0);
        if (bytesRead < expectedSize)
            return buffer.subarray(0, bytesRead);
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead: extraBytesRead } = await handle.read(probe, 0, 1, expectedSize);
        if (extraBytesRead > 0)
            return undefined;
        return buffer;
    }
    finally {
        await handle.close();
    }
}
function metadataSnapshotHash(stats) {
    return `metadata:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length)
                return;
            results[index] = await mapper(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}
function buildChangeFromSnapshots(file, before, after) {
    if (snapshotHash(before) === snapshotHash(after))
        return { undoable: true };
    const undo = { file, before, after };
    const status = changeStatus(before, after);
    const beforeContent = before.exists ? before.content : '';
    const afterContent = after.exists ? after.content : '';
    if ((before.exists || after.exists) &&
        beforeContent !== undefined &&
        afterContent !== undefined) {
        return {
            fileChange: buildTextFileChange(file, beforeContent, afterContent, status),
            undo,
            undoable: true,
        };
    }
    return {
        fileChange: {
            file,
            additions: 0,
            deletions: 0,
            status,
            ...(path.isAbsolute(file) || path.win32.isAbsolute(file) ? { external: true } : {}),
        },
        undo,
        undoable: false,
    };
}
function buildTextFileChange(file, before, after, status) {
    const oldFileName = `a/${file}`;
    const newFileName = `b/${file}`;
    const patch = buildStructuredPatch(oldFileName, newFileName, before, after);
    return {
        file,
        // Derive the counts from the exact hunks we render so the sidebar
        // `+N -N` badge always matches what the review panel shows.
        additions: countPatchLines(patch, '+'),
        deletions: countPatchLines(patch, '-'),
        status,
        diff: serializeUnifiedDiff(patch),
        patch,
        ...(path.isAbsolute(file) || path.win32.isAbsolute(file) ? { external: true } : {}),
    };
}
/**
 * Line-based structured patch between two text snapshots, scoped to the
 * actually-changed regions with `PATCH_CONTEXT_LINES` of context, so the
 * review panel no longer paints the whole file red+green for a single-line
 * edit. Identical contents produce an empty hunk list (the review panel
 * shows its "no diff" placeholder).
 *
 * When the edit distance exceeds `MAX_DIFF_EDIT_LENGTH` (a near-total
 * rewrite), jsdiff aborts and we fall back to the legacy whole-file
 * deletion+addition hunk — which is both cheap to build and a faithful
 * rendering of "everything changed".
 */
function buildStructuredPatch(oldFileName, newFileName, before, after) {
    const patch = structuredPatch(oldFileName, newFileName, before, after, undefined, undefined, {
        context: PATCH_CONTEXT_LINES,
        maxEditLength: MAX_DIFF_EDIT_LENGTH,
    });
    if (patch) {
        return { oldFileName, newFileName, hunks: patch.hunks };
    }
    const beforeLines = splitPatchLines(before);
    const afterLines = splitPatchLines(after);
    return {
        oldFileName,
        newFileName,
        hunks: [
            {
                oldStart: 1,
                oldLines: beforeLines.length,
                newStart: 1,
                newLines: afterLines.length,
                lines: [...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)],
            },
        ],
    };
}
function countPatchLines(patch, marker) {
    let count = 0;
    for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith(marker))
                count += 1;
        }
    }
    return count;
}
/** Render a structured patch as a unified-diff string (`---`/`+++`/`@@` hunks). */
function serializeUnifiedDiff(patch) {
    const lines = [`--- ${patch.oldFileName}`, `+++ ${patch.newFileName}`];
    for (const hunk of patch.hunks) {
        lines.push(`@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} +${formatHunkRange(hunk.newStart, hunk.newLines)} @@`);
        lines.push(...hunk.lines);
    }
    // Unified diffs are newline-terminated. The body always has at least the
    // `--- /+++` lines, so this never produces an empty string.
    return `${lines.join('\n')}\n`;
}
/** Render a unified-diff hunk range (`start` or `start,count`). */
function formatHunkRange(start, lineCount) {
    if (lineCount === 0)
        return `${start},0`;
    return lineCount === 1 ? `${start}` : `${start},${lineCount}`;
}
function splitPatchLines(text) {
    if (text.length === 0)
        return [];
    return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}
function snapshotHash(entry) {
    if (!entry.exists)
        return 'missing';
    return entry.hash ?? `content:${entry.content ?? ''}`;
}
function changeStatus(before, after) {
    if (!before.exists && after.exists)
        return 'added';
    if (before.exists && !after.exists)
        return 'deleted';
    return 'modified';
}
function mergeToolCaptures(captures) {
    const merged = new Map();
    for (const capture of captures) {
        const beforeByFile = new Map(capture.before.map((entry) => [entry.file, entry]));
        const afterByFile = new Map(capture.after.map((entry) => [entry.file, entry]));
        for (const file of capture.paths) {
            const before = beforeByFile.get(file);
            const after = afterByFile.get(file);
            if (!before || !after)
                continue;
            const existing = merged.get(file);
            if (existing) {
                existing.after = after;
            }
            else {
                merged.set(file, { before, after });
            }
        }
    }
    return new Map([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
function buildCapturedChanges(captures) {
    const fileChanges = [];
    const undo = [];
    let undoable = true;
    for (const [file, snapshots] of mergeToolCaptures(captures)) {
        const change = buildChangeFromSnapshots(file, snapshots.before, snapshots.after);
        if (!change.fileChange)
            continue;
        fileChanges.push(change.fileChange);
        if (change.undo)
            undo.push(change.undo);
        if (!change.undoable)
            undoable = false;
    }
    return { fileChanges, undo, undoable };
}
function buildFileChangeObservation(captures, fileChanges) {
    const changedFiles = [
        ...new Set(fileChanges.map((change) => change.file).filter(isWorkspaceRelativeObservationPath)),
    ].sort((left, right) => left.localeCompare(right));
    const ambiguousCaptures = captures.filter((capture) => capture.status === 'ambiguous' || Boolean(capture.ambiguityReason));
    if (ambiguousCaptures.length > 0) {
        return {
            fileChange: 'uncertain',
            ...(changedFiles.length > 0 ? { changedFiles } : {}),
            observationNotes: ambiguousCaptures.map((capture) => `ambiguous_tool_capture:${capture.toolCallId}:${capture.ambiguityReason ?? 'unknown'}`),
        };
    }
    if (fileChanges.length > 0) {
        return {
            fileChange: 'change_observed',
            ...(changedFiles.length > 0 ? { changedFiles } : {}),
            observationNotes: [],
        };
    }
    return {
        fileChange: 'no_observed_change',
        observationNotes: ['no_file_change_observed'],
    };
}
function buildToolArtifactProgressObservation(capture) {
    if (capture.status !== 'completed' || capture.ambiguityReason)
        return undefined;
    const beforeByFile = new Map(capture.before.map((entry) => [entry.file, entry]));
    const afterByFile = new Map(capture.after.map((entry) => [entry.file, entry]));
    const targets = capture.paths.filter(isWorkspaceRelativeObservationPath).sort();
    if (targets.length === 0)
        return undefined;
    let artifactChanged = false;
    const progressKey = [];
    for (const file of targets) {
        const before = beforeByFile.get(file);
        const after = afterByFile.get(file);
        // Legacy snapshot errors share the "missing" representation with real absence.
        // V1 only certifies two content-hashed states; creation/deletion stays unknown.
        const beforeState = contentSnapshotHash(before);
        const afterState = contentSnapshotHash(after);
        if (beforeState === undefined || afterState === undefined)
            return undefined;
        if (beforeState !== afterState)
            artifactChanged = true;
        progressKey.push({ file, state: afterState });
    }
    return {
        toolCallId: capture.toolCallId,
        loopKey: targets,
        progressKey,
        artifactChanged,
    };
}
function contentSnapshotHash(entry) {
    if (!entry?.exists || !entry.hash)
        return undefined;
    const state = snapshotHash(entry);
    return state.startsWith('metadata:') ? undefined : state;
}
function isWorkspaceRelativeObservationPath(file) {
    const normalized = file.replaceAll('\\', '/');
    return (normalized.length > 0 &&
        !path.isAbsolute(normalized) &&
        !path.win32.isAbsolute(normalized) &&
        normalized !== '..' &&
        !normalized.startsWith('../'));
}
function hasDynamicShellPathToken(token) {
    return (/\$\{?[\w@*]/.test(token) ||
        token.includes('$(') ||
        token.includes('`') ||
        /[*?[]/.test(token) ||
        token.startsWith('<(') ||
        token.startsWith('>(') ||
        token.startsWith('~'));
}
function isDiscardTarget(token) {
    return (token === '/dev/null' ||
        token === '/dev/stdout' ||
        token === '/dev/stderr' ||
        token === '/dev/tty' ||
        /^&\d+$/.test(token) ||
        token === '&-');
}
function isFilteredRelativePath(filePath) {
    const normalized = filePath.replaceAll('\\', '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.slice(0, -1).some((part) => TURN_FILE_CHANGE_FILTER_DIR_NAMES.has(part)))
        return true;
    if (parts.some((part, index) => part === BRAND.APP_DIR && (parts[index + 1] === 'plans' || parts[index + 1] === 'handoffs'))) {
        return true;
    }
    return TURN_FILE_CHANGE_FILTER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function shellTokenize(input) {
    const tokens = [];
    let current = '';
    let quote;
    let escaped = false;
    const flush = () => {
        if (current.length > 0)
            tokens.push(current);
        current = '';
    };
    for (let index = 0; index < input.length; index += 1) {
        const ch = input[index];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            const continuationLength = shellContinuationLength(input, index);
            if (continuationLength > 0) {
                index += continuationLength;
                continue;
            }
            escaped = true;
            continue;
        }
        if (isShellQuoteBoundary(ch, quote)) {
            quote = quote ? undefined : ch;
            continue;
        }
        if (isShellWhitespace(ch) && !quote) {
            flush();
            continue;
        }
        current += ch;
    }
    flush();
    return tokens;
}
function shellContinuationLength(input, index) {
    if (input[index + 1] === '\n')
        return 1;
    return input[index + 1] === '\r' && input[index + 2] === '\n' ? 2 : 0;
}
function isShellQuoteBoundary(ch, quote) {
    return (ch === "'" || ch === '"') && (!quote || quote === ch);
}
function isShellWhitespace(ch) {
    const code = ch.charCodeAt(0);
    return code === 32 || (code >= 9 && code <= 13);
}
//# sourceMappingURL=file-changes.js.map