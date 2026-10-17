import { isAbsolute, relative, resolve } from 'node:path';
import { extractBashPathIntents } from '@mavis/permission';
import { isSensitiveHandoffPath } from '@mavis/shared';
import { readHandoffToolCallWireFields } from './tool-call-wire.js';
export { isSensitiveHandoffPath } from '@mavis/shared';
const DEFAULT_MAX_CANDIDATES = 15_000;
const MODIFICATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch']);
const PATH_ARGUMENT_KEYS = new Set(['path', 'file_path', 'filePath', 'paths', 'files', 'target']);
const PROJECT_CONTEXT_FILES = [
    'go.mod',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'README.md',
];
/**
 * Dependency trees never belong to a handoff catalog. `safeRelativePath()` only rejects
 * repository internals, so this boundary is enforced here instead of trusting one scanner.
 */
const EXCLUDED_HANDOFF_DIRECTORIES = { node_modules: true };
const MODEL_SELECTION_REASON = 'Related to this request';
const MODEL_REASON_MAX_LENGTH = 120;
const MODEL_CANDIDATE_PATH_LIMIT = 300;
const MODEL_CANDIDATE_CHAR_BUDGET = 16_000;
const MODEL_NAMED_TOKEN_LENGTH = 3;
const CONTEXT_MESSAGE_LIMIT = 12;
const CONTEXT_MESSAGE_MAX_LENGTH = 400;
const CONTEXT_TEXT_KEYS = ['msg_content', 'content', 'text'];
/**
 * Builds the handoff catalog and marks its default-selected subset. Tool evidence is always
 * kept; the model may only add paths that are already catalog members.
 */
export function handoffFileCandidates(input) {
    const limit = boundedLimit(input.maxCandidates, DEFAULT_MAX_CANDIDATES);
    const files = new Map(input.files
        .filter((file) => eligibleHandoffPath(file.relativePath))
        .map((file) => [normalizeSlashes(file.relativePath), file]));
    const evidence = collectFileEvidence(input.workspaceDir, input.messages);
    const included = new Set();
    const modified = [];
    const used = [];
    for (const [relativePath, kind] of evidence) {
        const file = files.get(relativePath);
        if (!file)
            continue;
        included.add(relativePath);
        const candidate = toCandidate(file, kind === 'modified' ? 'Modified during this Session' : 'Used during this Session', true);
        (kind === 'modified' ? modified : used).push(candidate);
    }
    modified.sort(compareCandidatePath);
    used.sort(compareCandidatePath);
    const selection = input.modelSelection ?? { status: 'unavailable' };
    const chosen = selection.status === 'selected'
        ? modelSelectedCandidates(selection.files, files, included)
        : projectContextCandidates(files, included);
    const remaining = [...files.entries()]
        .filter(([relativePath, file]) => !included.has(relativePath) && !sensitiveCandidate(file, relativePath))
        .map(([, file]) => toCandidate(file, 'Workspace file', false))
        .sort(compareCandidatePath);
    return [...modified, ...used, ...chosen, ...remaining].slice(0, limit);
}
/**
 * Bounds what the catalog costs to send. A scan carries up to 15000 paths, so files the request
 * names go first — otherwise a deeply nested file the user asked about by name falls outside the
 * window and the model cannot pick it. Remaining budget goes to shallow paths, which are the
 * artifacts a user usually hands to Cloud.
 */
export function handoffModelCandidateBudget(candidates, input = {}) {
    const maxPaths = boundedLimit(input.maxPaths, MODEL_CANDIDATE_PATH_LIMIT);
    const maxChars = boundedLimit(input.maxChars, MODEL_CANDIDATE_CHAR_BUDGET);
    const request = (input.queryText ?? '').toLowerCase();
    const named = [];
    const rest = [];
    for (const candidate of [...candidates].sort(compareModelCandidatePath)) {
        const target = request.length > 0 && namedByRequest(candidate.relativePath, request);
        (target ? named : rest).push(candidate);
    }
    const result = [];
    let chars = 0;
    for (const candidate of [...named, ...rest]) {
        if (result.length >= maxPaths)
            break;
        chars += candidate.relativePath.length + 1;
        if (chars > maxChars)
            break;
        result.push({ relativePath: candidate.relativePath, sizeBytes: candidate.sizeBytes });
    }
    return result;
}
/**
 * Whether the request mentions a fragment of this path. Substring matching keeps one rule for
 * `pdf` inside `改一下pdf文件的主题色` and for a CJK name repeated verbatim; short tokens are
 * dropped because `a` or `ts` would match almost any request.
 */
function namedByRequest(relativePath, request) {
    return relativePath
        .toLowerCase()
        .split(/[\s/\\._-]+/u)
        .some((token) => token.length >= MODEL_NAMED_TOKEN_LENGTH && request.includes(token));
}
/** Recent Session context for the recommendation model. Truncated text only, never file bodies. */
export function recentHandoffContext(messages, limit = CONTEXT_MESSAGE_LIMIT) {
    const result = [];
    for (const message of limit > 0 ? messages.slice(-limit) : []) {
        const text = readString(message, CONTEXT_TEXT_KEYS).replaceAll(/\s+/gu, ' ').trim();
        if (!text)
            continue;
        const role = readString(message, ['role']) || 'message';
        result.push(`${role}: ${truncate(text, CONTEXT_MESSAGE_MAX_LENGTH)}`);
    }
    return result;
}
export function referencedHandoffPaths(workspaceDir, messages) {
    return [...collectFileEvidence(workspaceDir, messages).keys()];
}
export function toolCallReferencesUnapprovedSensitivePath(call, workspaceDir, approvedPaths) {
    const fields = readHandoffToolCallWireFields(call);
    const toolName = fields.name.toLowerCase();
    const args = readToolArguments(call);
    return callFileEvidence(toolName, args).some((evidence) => {
        const relativePath = workspaceRelativePath(workspaceDir, evidence.path);
        if (relativePath === undefined)
            return true;
        return isSensitiveHandoffPath(relativePath) && !approvedPaths.has(relativePath);
    });
}
function collectFileEvidence(workspaceDir, messages) {
    const result = new Map();
    for (const message of messages) {
        for (const call of readToolCalls(message)) {
            const fields = readHandoffToolCallWireFields(call);
            const toolName = fields.name.toLowerCase();
            const args = readToolArguments(call);
            for (const evidence of callFileEvidence(toolName, args)) {
                recordEvidence(result, evidence.kind, workspaceRelativePath(workspaceDir, evidence.path));
            }
        }
    }
    return result;
}
function callFileEvidence(toolName, args) {
    if (toolName === 'bash')
        return bashFileEvidence(args);
    const kind = MODIFICATION_TOOLS.has(toolName) ? 'modified' : 'used';
    return pathArguments(args).map((path) => ({ path, kind }));
}
function bashFileEvidence(args) {
    const command = readString(args, ['command', 'cmd']);
    if (!command)
        return [];
    return extractBashPathIntents(command).map((intent) => ({
        path: intent.path,
        kind: intent.action === 'write' || intent.action === 'delete' ? 'modified' : 'used',
    }));
}
function readToolCalls(message) {
    const value = Array.isArray(message.tool_calls) ? message.tool_calls : message.toolCalls;
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
        : [];
}
function readToolArguments(call) {
    const raw = readHandoffToolCallWireFields(call).args;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        return raw;
    }
    return parseToolArguments(raw);
}
function parseToolArguments(raw) {
    if (typeof raw !== 'string')
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
function pathArguments(args) {
    const result = [];
    for (const [key, value] of Object.entries(args)) {
        if (PATH_ARGUMENT_KEYS.has(key))
            appendPathArgument(result, value);
    }
    return result;
}
function appendPathArgument(result, value) {
    if (typeof value === 'string') {
        result.push(value);
        return;
    }
    if (!Array.isArray(value))
        return;
    result.push(...value.filter((item) => typeof item === 'string'));
}
function recordEvidence(result, kind, relativePath) {
    if (!relativePath)
        return;
    if (kind === 'modified' || !result.has(relativePath))
        result.set(relativePath, kind);
}
function workspaceRelativePath(workspaceDir, value) {
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const candidate = isAbsolute(trimmed)
        ? relative(resolve(workspaceDir), resolve(trimmed))
        : trimmed;
    const normalized = normalizeSlashes(candidate).replace(/^\.\//u, '');
    return safeRelativePath(normalized) ? normalized : undefined;
}
export function safeRelativePath(value) {
    if (!value || value.startsWith('/') || /^[A-Za-z]:\//u.test(value))
        return false;
    const segments = normalizeSlashes(value).split('/');
    return !segments.some((segment) => {
        const lower = segment.toLowerCase();
        return (segment === '' ||
            segment === '.' ||
            segment === '..' ||
            lower === '.git' ||
            lower === '.mavis');
    });
}
/**
 * Keeps only model paths that are already catalog members. Hallucinated, escaping, duplicated
 * and sensitive paths are dropped, so a model answer can never widen the handoff boundary.
 */
function modelSelectedCandidates(selection, files, included) {
    const result = [];
    for (const entry of selection) {
        if (typeof entry?.relativePath !== 'string')
            continue;
        const relativePath = normalizeSlashes(entry.relativePath.trim()).replace(/^\.\//u, '');
        const file = files.get(relativePath);
        if (!file || included.has(relativePath))
            continue;
        if (sensitiveCandidate(file, relativePath))
            continue;
        included.add(relativePath);
        const reason = typeof entry.reason === 'string' ? entry.reason.replaceAll(/\s+/gu, ' ').trim() : '';
        result.push(toCandidate(file, reason ? truncate(reason, MODEL_REASON_MAX_LENGTH) : MODEL_SELECTION_REASON, true));
    }
    return result;
}
/** Bounded project descriptors. Reached only when the recommendation model is unavailable. */
function projectContextCandidates(files, included) {
    return PROJECT_CONTEXT_FILES.flatMap((relativePath) => {
        const file = files.get(relativePath);
        if (!file || included.has(relativePath))
            return [];
        included.add(relativePath);
        return [toCandidate(file, 'Project context', true)];
    });
}
function sensitiveCandidate(file, relativePath) {
    return file.sensitive === true || isSensitiveHandoffPath(relativePath);
}
function eligibleHandoffPath(value) {
    if (!safeRelativePath(value))
        return false;
    return !normalizeSlashes(value)
        .split('/')
        .some((segment) => EXCLUDED_HANDOFF_DIRECTORIES[segment.toLowerCase()] === true);
}
function toCandidate(file, reason, recommended) {
    const relativePath = normalizeSlashes(file.relativePath);
    return {
        relativePath,
        reason,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        sensitive: sensitiveCandidate(file, relativePath),
        recommended,
    };
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string')
            return value;
    }
    return '';
}
function boundedLimit(value, fallback) {
    return Number.isSafeInteger(value) && (value ?? 0) > 0
        ? Math.min(value, fallback)
        : fallback;
}
function truncate(value, maxLength) {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
function compareModelCandidatePath(left, right) {
    const depth = left.relativePath.split('/').length - right.relativePath.split('/').length;
    return depth === 0 ? compareCandidatePath(left, right) : depth;
}
function compareCandidatePath(left, right) {
    return compareHandoffPaths(left.relativePath, right.relativePath);
}
export function compareHandoffPaths(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function normalizeSlashes(value) {
    return value.replaceAll('\\', '/');
}
//# sourceMappingURL=recommendation.js.map