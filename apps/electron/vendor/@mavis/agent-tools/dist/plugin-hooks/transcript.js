import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TRANSCRIPT_DIRECTORY_MODE = 0o700;
const TRANSCRIPT_FILE_MODE = 0o600;
const TRANSCRIPT_FILE_SUFFIXES = ['.compatible.jsonl', '.codex.jsonl'];
const DEFAULT_TRANSCRIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TRANSCRIPT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSCRIPT_MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAINTENANCE_STAT_BATCH_SIZE = 256;
const activeTranscriptPathOwners = new Map();
const transcriptPathLeaseFinalizer = new FinalizationRegistry(({ paths, owner }) => releaseTranscriptPaths(paths, owner));
/** Maintains separate Compatible conversation and Codex rollout projections. */
export class PluginHookTranscript {
    sessionId;
    cwd;
    directory;
    maxAgeMs;
    maxFileBytes;
    maxDirectoryBytes;
    nowMs;
    pathOwner;
    path;
    codexPath;
    messageOffset = 0;
    lastCompatibleUuid = null;
    operation = Promise.resolve();
    cleaned = false;
    constructor(sessionId, cwd, directory, maxAgeMs, maxFileBytes, maxDirectoryBytes, nowMs, pathOwner, path, codexPath) {
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.directory = directory;
        this.maxAgeMs = maxAgeMs;
        this.maxFileBytes = maxFileBytes;
        this.maxDirectoryBytes = maxDirectoryBytes;
        this.nowMs = nowMs;
        this.pathOwner = pathOwner;
        this.path = path;
        this.codexPath = codexPath;
    }
    static async create(input) {
        const directory = input.storage?.directory ?? pluginHookTranscriptDirectory();
        const nowMs = input.storage?.nowMs ?? Date.now;
        const maxAgeMs = positiveLimit(input.storage?.maxAgeMs, DEFAULT_TRANSCRIPT_MAX_AGE_MS);
        const maxFileBytes = positiveLimit(input.storage?.maxFileBytes, DEFAULT_TRANSCRIPT_MAX_FILE_BYTES);
        const maxDirectoryBytes = Math.max(maxFileBytes * 2, positiveLimit(input.storage?.maxDirectoryBytes, DEFAULT_TRANSCRIPT_MAX_DIRECTORY_BYTES));
        await mkdir(directory, { recursive: true, mode: TRANSCRIPT_DIRECTORY_MODE });
        const paths = pluginHookTranscriptPaths(input.sessionId, directory);
        const ownedPaths = [paths.path, paths.codexPath];
        const pathOwner = Symbol(input.sessionId);
        retainTranscriptPaths(ownedPaths, pathOwner);
        try {
            await maintainTranscriptDirectory(directory, {
                nowMs: nowMs(),
                maxAgeMs,
                maxDirectoryBytes,
                protectedPaths: new Set(ownedPaths),
            });
        }
        catch (error) {
            releaseTranscriptPaths(ownedPaths, pathOwner);
            throw error;
        }
        const transcript = new PluginHookTranscript(input.sessionId, input.cwd ?? process.cwd(), directory, maxAgeMs, maxFileBytes, maxDirectoryBytes, nowMs, pathOwner, paths.path, paths.codexPath);
        transcriptPathLeaseFinalizer.register(transcript, { paths: ownedPaths, owner: pathOwner }, transcript);
        try {
            await transcript.replace(input.messages);
            return transcript;
        }
        catch (error) {
            if (transcript.releasePathLease()) {
                await Promise.all([
                    rm(paths.path, { force: true }).catch(() => undefined),
                    rm(paths.codexPath, { force: true }).catch(() => undefined),
                ]);
            }
            throw error;
        }
    }
    onHistoryChanged = async (change) => {
        await this.apply(change);
    };
    async apply(change) {
        await this.enqueue(async () => {
            if (this.cleaned)
                return;
            if (change.reason === 'replaceMessages') {
                await this.replaceNow(change.messages);
                return;
            }
            if (change.messages.length === 0)
                return;
            const start = this.messageOffset;
            const compatible = serializeCompatibleMessages(this.sessionId, change.messages, start, this.lastCompatibleUuid);
            await Promise.all([
                appendBoundedJsonl(this.path, compatible.rows, this.maxFileBytes, false),
                appendCodexBoundedJsonl(this.codexPath, codexSessionMeta(this.sessionId, this.cwd, change.messages), change.messages.flatMap(codexRolloutRows), this.maxFileBytes),
            ]);
            this.messageOffset += change.messages.length;
            this.lastCompatibleUuid = compatible.lastUuid;
            await this.maintainDirectory();
        });
    }
    /** Deletes both vendor projections. Safe to call repeatedly or after a failed create/apply. */
    async cleanup() {
        await this.enqueue(async () => {
            if (this.cleaned)
                return;
            this.cleaned = true;
            if (this.releasePathLease()) {
                await Promise.all([
                    rm(this.path, { force: true }).catch(() => undefined),
                    rm(this.codexPath, { force: true }).catch(() => undefined),
                ]);
            }
        });
    }
    async replace(messages) {
        await this.enqueue(() => this.replaceNow(messages));
    }
    async replaceNow(messages) {
        if (this.cleaned)
            return;
        const compatible = serializeCompatibleMessages(this.sessionId, messages, 0, null);
        await Promise.all([
            writeJsonl(this.path, compatible.rows, this.maxFileBytes, false),
            writeJsonl(this.codexPath, [
                codexSessionMeta(this.sessionId, this.cwd, messages),
                ...messages.flatMap(codexRolloutRows),
            ], this.maxFileBytes, true),
        ]);
        this.messageOffset = messages.length;
        this.lastCompatibleUuid = compatible.lastUuid;
        await this.maintainDirectory();
    }
    enqueue(operation) {
        const pending = this.operation.then(operation, operation);
        this.operation = pending.then(() => undefined, () => undefined);
        return pending;
    }
    maintainDirectory() {
        return maintainTranscriptDirectory(this.directory, {
            nowMs: this.nowMs(),
            maxAgeMs: this.maxAgeMs,
            maxDirectoryBytes: this.maxDirectoryBytes,
            protectedPaths: new Set([this.path, this.codexPath]),
        });
    }
    releasePathLease() {
        transcriptPathLeaseFinalizer.unregister(this);
        return releaseTranscriptPaths([this.path, this.codexPath], this.pathOwner);
    }
}
export function pluginHookTranscriptDirectory() {
    return join(tmpdir(), 'minimax-plugin-hooks', 'transcripts');
}
export function pluginHookTranscriptPath(sessionId, directory = pluginHookTranscriptDirectory()) {
    return pluginHookTranscriptPaths(sessionId, directory).path;
}
export function pluginHookCodexTranscriptPath(sessionId, directory = pluginHookTranscriptDirectory()) {
    return pluginHookTranscriptPaths(sessionId, directory).codexPath;
}
function pluginHookTranscriptPaths(sessionId, directory) {
    const key = sessionKey(sessionId);
    return {
        path: join(directory, `${key}.compatible.jsonl`),
        codexPath: join(directory, `${key}.codex.jsonl`),
    };
}
function positiveLimit(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}
function sessionKey(sessionId) {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}
function serializeCompatibleMessages(sessionId, messages, startIndex, initialParentUuid) {
    let parentUuid = initialParentUuid;
    const rows = messages.map((message, index) => {
        const row = compatibleTranscriptRow(sessionId, message, startIndex + index, parentUuid);
        parentUuid = row.uuid;
        return row;
    });
    return {
        rows,
        lastUuid: parentUuid,
    };
}
function compatibleTranscriptRow(sessionId, message, index, parentUuid) {
    const common = {
        uuid: stableMessageId(sessionId, message, index),
        parentUuid,
        sessionId,
        timestamp: new Date(message.timestamp).toISOString(),
    };
    if (message.role === 'assistant') {
        return {
            ...common,
            type: 'assistant',
            message: {
                role: 'assistant',
                content: message.content.map((part) => part.type === 'toolCall'
                    ? { type: 'tool_use', id: part.id, name: part.name, input: part.arguments }
                    : normalizedContentPart(part)),
            },
        };
    }
    if (message.role === 'toolResult') {
        return {
            ...common,
            type: 'user',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: message.toolCallId,
                        content: normalizedContentBlocks(message.content),
                        is_error: message.isError,
                    },
                ],
            },
            toolUseResult: normalizedContentBlocks(message.content),
        };
    }
    if (message.role === 'user') {
        return {
            ...common,
            type: 'user',
            message: { role: 'user', content: normalizedContentBlocks(message.content) },
        };
    }
    const fallback = message;
    return {
        ...common,
        type: 'system',
        subtype: typeof fallback.customType === 'string' ? fallback.customType : message.role,
        message: {
            role: 'user',
            content: normalizedContentBlocks(fallback.content ?? JSON.stringify(fallback)),
        },
    };
}
function stableMessageId(sessionId, message, index) {
    return `projection-${index}-${createHash('sha256')
        .update(sessionId)
        .update(message.role)
        .update(String(message.timestamp))
        .update(message.role === 'toolResult' ? message.toolCallId : '')
        .digest('hex')
        .slice(0, 16)}`;
}
function codexSessionMeta(sessionId, cwd, messages) {
    const timestamp = new Date(messages[0]?.timestamp ?? Date.now()).toISOString();
    const id = stableCodexThreadId(sessionId);
    return {
        timestamp,
        type: 'session_meta',
        payload: {
            session_id: id,
            id,
            timestamp,
            cwd,
            originator: 'minimax_plugin_hook_projection',
            cli_version: 'minimax-plugin-hook-projection-v1',
            model_provider: null,
            base_instructions: null,
        },
    };
}
function stableCodexThreadId(sessionId) {
    const hex = createHash('sha256').update(sessionId).digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex
        .slice(12, 16)
        .join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
function codexRolloutRows(message) {
    const timestamp = new Date(message.timestamp).toISOString();
    const wrap = (payload) => ({ timestamp, type: 'response_item', payload });
    if (message.role === 'user') {
        const content = normalizedContentBlocks(message.content);
        return [
            wrap({
                type: 'message',
                role: 'user',
                content: content.map((part) => ({ type: 'input_text', text: part.text })),
            }),
        ];
    }
    if (message.role === 'assistant') {
        const text = message.content.filter((part) => part.type === 'text');
        const calls = message.content.filter((part) => part.type === 'toolCall');
        return [
            ...(text.length
                ? [
                    wrap({
                        type: 'message',
                        role: 'assistant',
                        content: text.map((part) => ({ type: 'output_text', text: part.text })),
                    }),
                ]
                : []),
            ...calls.map((call) => wrap({
                type: 'function_call',
                name: call.name,
                arguments: JSON.stringify(call.arguments),
                call_id: call.id,
            })),
        ];
    }
    if (message.role === 'toolResult') {
        return [
            wrap({
                type: 'function_call_output',
                call_id: message.toolCallId,
                output: message.content.map((part) => normalizedContentPart(part).text).join('\n'),
            }),
        ];
    }
    const fallback = message;
    return [
        wrap({
            type: 'message',
            role: 'developer',
            content: [
                {
                    type: 'input_text',
                    text: normalizedContentBlocks(fallback.content ?? JSON.stringify(fallback))
                        .map((part) => part.text)
                        .join('\n'),
                },
            ],
        }),
    ];
}
function normalizedContentBlocks(value) {
    if (typeof value === 'string')
        return [{ type: 'text', text: value }];
    if (!Array.isArray(value)) {
        return [{ type: 'text', text: JSON.stringify(value) ?? String(value) }];
    }
    const blocks = [];
    for (const part of value) {
        if (!part || typeof part !== 'object' || Array.isArray(part))
            continue;
        const record = part;
        if (record.type === 'text' && typeof record.text === 'string') {
            blocks.push({ type: 'text', text: record.text });
            continue;
        }
        if (record.type === 'image' &&
            typeof record.data === 'string' &&
            typeof record.mimeType === 'string') {
            blocks.push({ type: 'text', text: `[image omitted: ${record.mimeType}]` });
        }
    }
    return blocks;
}
function normalizedContentPart(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value;
        if (record.type === 'text' && typeof record.text === 'string') {
            return { type: 'text', text: record.text };
        }
        if (record.type === 'image' && typeof record.mimeType === 'string') {
            return { type: 'text', text: `[image omitted: ${record.mimeType}]` };
        }
    }
    return { type: 'text', text: JSON.stringify(value) ?? String(value) };
}
async function appendBoundedJsonl(path, rows, maxBytes, preserveFirst) {
    if (rows.length === 0)
        return;
    let existing = '';
    try {
        existing = await readFile(path, 'utf8');
    }
    catch {
        // A missing projection is recreated from the current delta.
    }
    const existingRows = parseJsonLines(existing);
    await writeJsonl(path, [...existingRows, ...rows], maxBytes, preserveFirst);
}
async function appendCodexBoundedJsonl(path, sessionMeta, rows, maxBytes) {
    if (rows.length === 0)
        return;
    let existing = '';
    try {
        existing = await readFile(path, 'utf8');
    }
    catch {
        // Recreate a complete Codex rollout if external cleanup removed the projection.
    }
    const existingRows = parseJsonLines(existing);
    const first = existingRows[0];
    const completeRows = first?.type === 'session_meta' ? existingRows : [sessionMeta, ...existingRows];
    await writeJsonl(path, [...completeRows, ...rows], maxBytes, true);
}
async function writeJsonl(path, rows, maxBytes, preserveFirst) {
    const text = boundedJsonl(rows, maxBytes, preserveFirst);
    await writeFile(path, text, { encoding: 'utf8', mode: TRANSCRIPT_FILE_MODE });
}
function boundedJsonl(rows, maxBytes, preserveFirst) {
    if (rows.length === 0)
        return '';
    const serialized = rows.map((row) => JSON.stringify(row));
    const first = preserveFirst ? serialized[0] : undefined;
    const tail = preserveFirst ? serialized.slice(1) : serialized;
    let used = first ? Buffer.byteLength(`${first}\n`) : 0;
    const kept = [];
    for (let index = tail.length - 1; index >= 0; index -= 1) {
        const row = tail[index];
        if (row === undefined)
            continue;
        const bytes = Buffer.byteLength(`${row}\n`);
        if (used + bytes > maxBytes)
            continue;
        kept.unshift(row);
        used += bytes;
    }
    return [...(first ? [first] : []), ...kept].map((row) => `${row}\n`).join('');
}
function parseJsonLines(text) {
    return text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
}
async function maintainTranscriptDirectory(directory, input) {
    const protectedPaths = new Set([...input.protectedPaths, ...activeTranscriptPathOwners.keys()]);
    let names;
    try {
        names = (await readdir(directory)).filter(isTranscriptFileName);
    }
    catch {
        return;
    }
    const files = [];
    for (let offset = 0; offset < names.length; offset += MAINTENANCE_STAT_BATCH_SIZE) {
        const batch = names.slice(offset, offset + MAINTENANCE_STAT_BATCH_SIZE);
        const batchMetadata = await Promise.all(batch.map(async (name) => {
            const path = join(directory, name);
            try {
                const entryMetadata = await stat(path);
                return entryMetadata.isFile()
                    ? { path, size: entryMetadata.size, modifiedAtMs: entryMetadata.mtimeMs }
                    : undefined;
            }
            catch {
                return undefined;
            }
        }));
        files.push(...batchMetadata.filter((file) => file !== undefined));
    }
    for (const file of files) {
        if (!protectedPaths.has(file.path) && input.nowMs - file.modifiedAtMs > input.maxAgeMs) {
            await rm(file.path, { force: true }).catch(() => undefined);
            file.size = 0;
        }
    }
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of [...files].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)) {
        if (totalBytes <= input.maxDirectoryBytes)
            break;
        if (file.size === 0 || protectedPaths.has(file.path))
            continue;
        await rm(file.path, { force: true }).catch(() => undefined);
        totalBytes -= file.size;
    }
}
function retainTranscriptPaths(paths, owner) {
    for (const path of paths) {
        const owners = activeTranscriptPathOwners.get(path) ?? new Set();
        owners.add(owner);
        activeTranscriptPathOwners.set(path, owners);
    }
}
function releaseTranscriptPaths(paths, owner) {
    for (const path of paths) {
        const owners = activeTranscriptPathOwners.get(path);
        if (!owners)
            continue;
        owners.delete(owner);
        if (owners.size === 0)
            activeTranscriptPathOwners.delete(path);
    }
    return paths.every((path) => !activeTranscriptPathOwners.has(path));
}
function isTranscriptFileName(name) {
    return TRANSCRIPT_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
//# sourceMappingURL=transcript.js.map