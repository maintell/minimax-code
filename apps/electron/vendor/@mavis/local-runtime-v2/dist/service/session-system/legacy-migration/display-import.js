import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
const DISPLAY_BATCH_COUNT = 250;
const DISPLAY_BATCH_BYTES = 8 * 1024 * 1024;
const INLINE_BINARY_THRESHOLD = 1_024;
const BASE64_CHARS = /^[A-Za-z0-9+/_=\s-]+$/u;
export async function importLegacyDisplayStream(options) {
    const existing = (await options.messages.list(options.targetSessionId)).messages;
    const duplicateSourceIds = new Set(options.duplicateSourceMsgIds);
    const existingById = new Map(existing.flatMap((message) => message.msg_id && !duplicateSourceIds.has(message.msg_id)
        ? [[message.msg_id, message]]
        : []));
    const state = {
        seenSourceIds: new Map(),
        sourceIds: new Set(),
        duplicateSourceIds,
        sourceIndex: 0,
        parsedCount: 0,
        duplicateRewritten: 0,
        missingAssigned: 0,
    };
    const attachments = { copied: 0, dataUrl: 0, missing: 0 };
    const displayHash = createHash('sha256');
    displayHash.update('[');
    let checksumCount = 0;
    let importedCount = 0;
    const serialize = (message) => {
        const json = JSON.stringify(message);
        if (json === undefined)
            throw new TypeError('Display message cannot be serialized');
        if (checksumCount > 0)
            displayHash.update(',');
        displayHash.update(json);
        checksumCount += 1;
        importedCount += 1;
        return { message, bytes: Buffer.byteLength(json, 'utf8') };
    };
    const batches = transformedDisplayBatches({
        ...options,
        existing,
        existingById,
        state,
        attachments,
        serialize,
    });
    await options.messages.replaceStream({ sessionId: options.targetSessionId, batches });
    displayHash.update(']');
    return {
        count: importedCount,
        checksum: displayHash.digest('hex'),
        parsedCount: state.parsedCount,
        duplicateRewritten: state.duplicateRewritten,
        missingAssigned: state.missingAssigned,
        warnings: [
            ...(state.duplicateRewritten > 0
                ? [`legacy_duplicate_msg_id_rewritten:${String(state.duplicateRewritten)}`]
                : []),
            ...(state.missingAssigned > 0
                ? [`legacy_missing_msg_id_assigned:${String(state.missingAssigned)}`]
                : []),
        ],
        attachments,
    };
}
async function* transformedDisplayBatches(options) {
    let batch = [];
    let batchBytes = 2;
    const enqueue = (serialized) => {
        const separatorBytes = batch.length > 0 ? 1 : 0;
        if (batch.length > 0 && batchBytes + separatorBytes + serialized.bytes > DISPLAY_BATCH_BYTES) {
            const ready = batch;
            batch = [serialized.message];
            batchBytes = 2 + serialized.bytes;
            return ready;
        }
        batch.push(serialized.message);
        batchBytes += separatorBytes + serialized.bytes;
        if (batch.length >= DISPLAY_BATCH_COUNT || batchBytes >= DISPLAY_BATCH_BYTES) {
            const ready = batch;
            batch = [];
            batchBytes = 2;
            return ready;
        }
        return undefined;
    };
    for await (const page of options.source.streamMessagePages(options.sourceSessionId, DISPLAY_BATCH_COUNT, DISPLAY_BATCH_BYTES)) {
        options.state.parsedCount += page.length;
        const preferred = page.map((message) => preferExistingMessage(prepareSourceMessage(message, options.state), options));
        const normalized = await Promise.all(preferred.map((message) => normalizeMessageAttachments(message, options)));
        const transformed = normalized.map((message) => options.serialize(sanitizeDisplayMessage(message)));
        for (const message of transformed) {
            const ready = enqueue(message);
            if (ready)
                yield ready;
        }
    }
    for (const message of options.existing) {
        if (message.msg_id && options.state.sourceIds.has(message.msg_id))
            continue;
        const normalized = await normalizeMessageAttachments(message, options);
        const ready = enqueue(options.serialize(sanitizeDisplayMessage(normalized)));
        if (ready)
            yield ready;
    }
    if (batch.length > 0)
        yield batch;
}
function prepareSourceMessage(message, state) {
    const original = typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
    const base = original ?? `legacy-missing-msg-id-${String(state.sourceIndex + 1)}`;
    const count = state.seenSourceIds.get(base) ?? 0;
    state.seenSourceIds.set(base, count + 1);
    const sourceIndex = state.sourceIndex;
    state.sourceIndex += 1;
    if (!original) {
        state.missingAssigned += 1;
        const prepared = {
            ...message,
            msg_id: `${base}-${checksumJson(message).slice(0, 12)}`,
        };
        state.sourceIds.add(prepared.msg_id);
        return prepared;
    }
    if (count > 0) {
        state.duplicateRewritten += 1;
        const prepared = {
            ...message,
            msg_id: `${base}__legacy_dup_${String(count + 1)}_${String(sourceIndex + 1)}`,
        };
        state.sourceIds.add(prepared.msg_id);
        return prepared;
    }
    state.sourceIds.add(original);
    return message;
}
function preferExistingMessage(message, options) {
    if (!message.msg_id || options.state.duplicateSourceIds.has(message.msg_id))
        return message;
    return options.existingById.get(message.msg_id) ?? message;
}
async function normalizeMessageAttachments(message, options) {
    if (!Array.isArray(message.attachments))
        return message;
    const attachments = await Promise.all(message.attachments.map((candidate) => normalizeAttachment(candidate, options)));
    return { ...message, attachments };
}
async function normalizeAttachment(candidate, options) {
    if (!isRecord(candidate))
        return candidate;
    const source = attachmentSource(candidate);
    if (readString(candidate.asset_id) ?? readString(candidate.assetId))
        return candidate;
    if (!source.sourcePath && !source.dataUrl)
        return candidate;
    try {
        const asset = await options.assets.register({
            fileName: attachmentFileName(candidate),
            mimeType: attachmentMimeType(candidate),
            ...source,
            sourceKind: 'legacy-migration',
            sessionId: options.sourceSessionId,
            nowMs: options.nowMs,
        });
        if (source.dataUrl)
            options.attachments.dataUrl += 1;
        else
            options.attachments.copied += 1;
        return importedAttachmentMetadata(candidate, asset);
    }
    catch {
        options.attachments.missing += 1;
        return candidate;
    }
}
function attachmentSource(candidate) {
    return {
        sourcePath: readString(candidate.file_path) ?? readString(candidate.filePath),
        dataUrl: readString(candidate.data_url) ?? readString(candidate.dataUrl),
    };
}
function attachmentFileName(candidate) {
    return readString(candidate.file_name) ?? readString(candidate.fileName) ?? 'attachment';
}
function attachmentMimeType(candidate) {
    return (readString(candidate.mime_type) ?? readString(candidate.mimeType) ?? 'application/octet-stream');
}
function importedAttachmentMetadata(candidate, asset) {
    const metadata = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'data_url' && key !== 'dataUrl'));
    return {
        ...metadata,
        file_path: asset.absolutePath,
        file_name: asset.fileName,
        mime_type: asset.mimeType,
        asset_id: asset.assetId,
    };
}
function sanitizeDisplayMessage(message) {
    if (!Array.isArray(message.tool_calls))
        return message;
    let changed = false;
    const toolCalls = message.tool_calls.map((candidate) => {
        if (!isRecord(candidate) || typeof candidate.tool_call_result_data !== 'string') {
            return candidate;
        }
        const cleaned = sanitizeWireToolCallResultData(candidate.tool_call_result_data);
        if (cleaned === candidate.tool_call_result_data)
            return candidate;
        changed = true;
        return { ...candidate, tool_call_result_data: cleaned };
    });
    return changed ? { ...message, tool_calls: toolCalls } : message;
}
/** Keeps legacy display rows compact without importing the Agent runtime owner. */
function sanitizeWireToolCallResultData(raw) {
    if (!raw)
        return raw;
    const first = raw.trimStart()[0];
    if (first !== '{' && first !== '[') {
        return raw.length > INLINE_BINARY_THRESHOLD ? `<omitted:non-json ${raw.length} bytes>` : raw;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return raw.length > INLINE_BINARY_THRESHOLD
            ? `<omitted:invalid-json ${raw.length} bytes>`
            : raw;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.content))
        return raw;
    const content = parsed.content.filter((block) => !isInlineBinaryBlock(block));
    if (content.length === parsed.content.length)
        return raw;
    return JSON.stringify({ ...parsed, content });
}
function isInlineBinaryBlock(value) {
    if (!isRecord(value) || typeof value.data !== 'string')
        return false;
    const type = typeof value.type === 'string' ? value.type : '';
    if (['image', 'video', 'audio', 'file'].includes(type))
        return true;
    const sample = value.data.length > 256 ? value.data.slice(0, 256) : value.data;
    return value.data.length >= INLINE_BINARY_THRESHOLD && BASE64_CHARS.test(sample);
}
export function checksumJson(value) {
    return createHash('sha256')
        .update(JSON.stringify(value) ?? 'undefined')
        .digest('hex');
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=display-import.js.map