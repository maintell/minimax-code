import { createHash } from 'node:crypto';
import { SessionHandoffError } from '../errors.js';
import { buildHandoffHistoryDigest } from './history-digest.js';
import { compareHandoffPaths, toolCallReferencesUnapprovedSensitivePath, } from './recommendation.js';
import { readHandoffToolCallWireFields } from './tool-call-wire.js';
export function assertHistoryCheckpoint(operation, messages) {
    if (!operation.historyCheckpoint) {
        throw new SessionHandoffError('HANDOFF_PROPOSAL_STALE', 'Cloud handoff proposal is missing its conversation checkpoint');
    }
    const current = completedHandoffCheckpoint(messages);
    if (current.turnCount === operation.historyCheckpoint.turnCount &&
        current.lastMessageId === operation.historyCheckpoint.lastMessageId) {
        return;
    }
    throw new SessionHandoffError('HANDOFF_PROPOSAL_STALE', 'Conversation changed after Cloud handoff approval was proposed');
}
/**
 * 生成脱敏后的本地文稿。这是**摘要器的输入**,不再直接上传:未被批准的敏感路径
 * 会在这里被抹掉,摘要基于它生成才不会把用户没勾选的内容带上云端。
 */
export function redactedHandoffMessages(input, files) {
    const approvedPaths = new Set(files.map((file) => file.relativePath));
    return input.messages.map((message) => importedMessage(message, input.session.workspaceDir, approvedPaths));
}
export function buildHandoffArtifacts(input, revisionId, files, summary) {
    const checkpoint = completedHandoffCheckpoint(input.messages);
    const transferFiles = transferManifestFiles(files);
    const manifestHash = sha256(JSON.stringify(transferFiles));
    // checkpoint 仍取自真实的本地历史:服务端把它与 dispatch 记录逐字段比对,
    // 它代表"派发时本地进行到哪一步",与上传哪几条消息是两回事。
    const history = encodeJson({
        schema_version: 1,
        local_session_id: input.session.sessionId,
        checkpoint: {
            turn_count: checkpoint.turnCount,
            last_message_id: checkpoint.lastMessageId,
        },
        messages: buildHandoffHistoryDigest({
            dispatchId: input.dispatchId,
            messages: input.messages,
            summary,
        }),
    });
    const handoff = encodeJson({
        schema_version: 1,
        objective: latestUserContent(input.messages) || input.session.title || 'Continue the task',
        key_files: transferFiles.map((file) => file.relative_path),
    });
    // 只写服务端 FileManifest 认识的四个字段:它以 DisallowUnknownFields 解码,
    // 多一个键整份产物就会被判 invalid。recommended_files / selected_paths 也
    // 不该出现在这里 —— 前者会把未选中文件的路径和敏感标记一并带上云端,
    // 超出用户这次批准的范围,而云端并不消费它们。
    const manifest = encodeJson({
        schema_version: 1,
        workspace_revision_id: revisionId,
        manifest: {
            manifest_hash: manifestHash,
            file_count: transferFiles.length,
            total_bytes: transferFiles.reduce((total, file) => total + file.size_bytes, 0),
        },
        files: transferFiles,
    });
    const bodies = new Map([
        ['imported_history', history],
        ['handoff_context', handoff],
        ['file_manifest', manifest],
    ]);
    const descriptors = [...bodies].map(([kind, body]) => ({
        kind,
        sha256: sha256(body),
        sizeBytes: body.byteLength,
    }));
    return {
        checkpoint,
        descriptors,
        workspace: {
            revisionId,
            manifest: {
                manifestHash,
                fileCount: transferFiles.length,
                totalBytes: transferFiles.reduce((total, file) => total + file.size_bytes, 0),
            },
        },
        bodies,
    };
}
export function approvedWorkspaceRevision(operation, currentFiles) {
    // A frozen Prepare is the approved identity, including for old operations whose
    // manually added files were saved without updating the original catalog revision.
    if (operation.prepareReplay) {
        const approved = operation.prepareReplay.workspace;
        if (sha256(JSON.stringify(transferManifestFiles(currentFiles))) !== approved.manifest.manifestHash) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Approved Workspace files changed after Prepare began');
        }
        return approved.revisionId;
    }
    const catalog = operation.files ?? [];
    const baseRevision = operation.catalogRevision ??
        `sha256:${sha256(JSON.stringify([...catalog]
            .sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath))
            .map((file) => [file.relativePath, file.sizeBytes, file.sha256])))}`;
    const catalogPaths = new Set(catalog.map((file) => file.relativePath));
    const additions = currentFiles
        .filter((file) => !catalogPaths.has(file.relativePath))
        .sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath))
        .map((file) => [file.relativePath, file.sizeBytes, file.sha256]);
    return additions.length === 0
        ? baseRevision
        : `sha256:${sha256(JSON.stringify([baseRevision, additions]))}`;
}
function transferManifestFiles(files) {
    return [...files]
        .sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath))
        .map((file) => ({
        relative_path: file.relativePath,
        sha256: file.sha256,
        size_bytes: file.sizeBytes,
        sensitive: file.sensitive === true,
    }));
}
export function normalizeSelectedPaths(selected, files) {
    if (selected.length === 0)
        return [];
    const available = new Set(files.map((file) => file.relativePath));
    const normalized = [...new Set(selected.map((path) => path.trim()).filter(Boolean))].sort(compareHandoffPaths);
    if (normalized.length === 0 || normalized.some((path) => !available.has(path))) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Selected handoff files are not part of the current Workspace revision');
    }
    return normalized;
}
export async function uploadArtifacts(cloud, tickets, bodies) {
    for (const ticket of tickets) {
        const body = bodies.get(ticket.kind);
        if (!body) {
            throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', `Missing ${ticket.kind} artifact body`);
        }
        await cloud.uploadArtifact(ticket, body);
    }
}
export function completedHandoffCheckpoint(messages) {
    const turns = new Map();
    for (const message of messages) {
        const turnId = messageTurnId(message);
        if (!turnId)
            continue;
        const state = turns.get(turnId) ?? { user: false, assistant: false };
        if (message.role === 'user')
            state.user = true;
        if (message.role === 'assistant')
            state.assistant = true;
        turns.set(turnId, state);
    }
    // A stopped first Turn may only have its user message. Count real recorded
    // conversational Turns without requiring an assistant response or fabricating one.
    const turnCount = [...turns.values()].filter((turn) => turn.user || turn.assistant).length;
    const lastMessageId = readMessageString(messages.at(-1), ['msg_id', 'msgId']);
    if (turnCount <= 0 || !lastMessageId) {
        throw new SessionHandoffError('HANDOFF_HISTORY_INVALID', 'Session handoff requires a recorded Turn checkpoint');
    }
    return { turnCount, lastMessageId };
}
function importedMessage(message, workspaceDir, approvedPaths) {
    const result = {
        msg_id: readMessageString(message, ['msg_id', 'msgId']),
        role: message.role ?? '',
    };
    copyString(message, result, 'parent_msg_id', ['parent_msg_id', 'parentMsgId']);
    copyString(message, result, 'msg_content', ['msg_content', 'content']);
    copyString(message, result, 'thinking_content', ['thinking_content', 'thinkingContent']);
    copyString(message, result, 'finish_reason', ['finish_reason', 'finishReason']);
    copyString(message, result, 'source', ['source']);
    copyString(message, result, 'kind', ['kind']);
    const turnId = messageTurnId(message);
    if (turnId)
        result.turn_id = turnId;
    copyNumber(message, result, 'timestamp', ['timestamp', 'created_at']);
    copyNumber(message, result, 'msg_type', ['msg_type', 'msgType']);
    copyNumber(message, result, 'thinking_duration_ms', [
        'thinking_duration_ms',
        'thinkingDurationMs',
    ]);
    const toolCalls = importedToolCalls(message.tool_calls ?? message.toolCalls, workspaceDir, approvedPaths);
    if (toolCalls.length > 0)
        result.tool_calls = toolCalls;
    const attachments = importedAttachments(message.attachments);
    if (attachments.length > 0)
        result.attachments = attachments;
    return result;
}
function importedToolCalls(value, workspaceDir, approvedPaths) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        const imported = importedToolCall(entry, workspaceDir, approvedPaths);
        return imported ? [imported] : [];
    });
}
function importedToolCall(value, workspaceDir, approvedPaths) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const call = value;
    const fields = readHandoffToolCallWireFields(call);
    if (!fields.name || !fields.id)
        return undefined;
    const imported = {
        tool_name: fields.name,
        tool_call_id: fields.id,
    };
    assignDefined(imported, 'tool_call_status', fields.status);
    const redactsSensitivePath = toolCallReferencesUnapprovedSensitivePath(call, workspaceDir, approvedPaths);
    const redactedPayload = JSON.stringify({
        redacted: true,
        reason: 'sensitive_file_not_approved',
    });
    const args = serializedToolPayload(fields.args);
    assignDefined(imported, 'tool_call_args', redactedToolPayload(args, redactsSensitivePath, redactedPayload));
    assignDefined(imported, 'tool_call_result_data', importedToolResult(fields.result, redactsSensitivePath, redactedPayload));
    assignArray(imported, 'plugin_provenances', firstDefined(call, ['plugin_provenances', 'pluginProvenances']));
    return imported;
}
function importedToolResult(value, redactsSensitivePath, redactedPayload) {
    return redactsSensitivePath ? redactedPayload : serializedToolPayload(value);
}
function redactedToolPayload(value, redactsSensitivePath, redactedPayload) {
    if (value === undefined)
        return undefined;
    return redactsSensitivePath ? redactedPayload : value;
}
function assignDefined(target, key, value) {
    if (value !== undefined)
        target[key] = value;
}
function assignArray(target, key, value) {
    if (Array.isArray(value))
        target[key] = value;
}
function firstDefined(source, keys) {
    for (const key of keys) {
        if (source[key] !== undefined)
            return source[key];
    }
    return undefined;
}
function serializedToolPayload(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined)
        return undefined;
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
function importedAttachments(value) {
    if (!Array.isArray(value))
        return [];
    const result = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            continue;
        const attachment = entry;
        const rawMeta = attachment.meta;
        const meta = typeof rawMeta === 'object' && rawMeta !== null && !Array.isArray(rawMeta)
            ? rawMeta
            : attachment;
        const imported = {};
        copyString(meta, imported, 'attachment_type', ['attachment_type', 'attachmentType', 'type']);
        copyString(meta, imported, 'file_name', ['file_name', 'fileName', 'name']);
        copyString(meta, imported, 'mime_type', ['mime_type', 'mimeType']);
        copyNumber(meta, imported, 'size_bytes', ['size_bytes', 'sizeBytes', 'size']);
        if (Object.keys(imported).length > 0)
            result.push(imported);
    }
    return result;
}
export function latestUserContent(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user')
            continue;
        const content = readMessageString(message, ['msg_content', 'content']);
        if (content)
            return content;
    }
    return '';
}
function messageTurnId(message) {
    return (readMessageString(message, ['turnId', 'turn_id']) ||
        (typeof message.meta?.turnId === 'string' ? message.meta.turnId : ''));
}
function readMessageString(message, keys) {
    if (!message)
        return '';
    for (const key of keys) {
        const value = message[key];
        if (typeof value === 'string')
            return value;
    }
    return '';
}
function copyString(source, target, targetKey, sourceKeys) {
    const value = readMessageString(source, sourceKeys);
    if (value)
        target[targetKey] = value;
}
function copyNumber(source, target, targetKey, sourceKeys) {
    for (const key of sourceKeys) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            target[targetKey] = value;
            return;
        }
    }
}
function encodeJson(value) {
    return Buffer.from(JSON.stringify(value), 'utf8');
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
//# sourceMappingURL=artifacts.js.map