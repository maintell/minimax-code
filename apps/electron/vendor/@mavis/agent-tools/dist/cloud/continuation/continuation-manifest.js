import { SHARE_CONTINUATION_MANIFEST_SCHEMA } from '@mavis/protocol';
import { HistoryToolGroupValidationError, resolveCompletedToolGroup, } from './completed-tool-group.js';
import { ContinuationHistoryValidationError } from './continuation-errors.js';
import { ShareContinuationManifestSchema, } from './continuation-types.js';
import { historyRecordsToPersistedMessages, persistedMessagesToHistoryRecords, } from './history-record-adapter.js';
import { synthesizeLegacySourceAssetRecords } from './legacy-source-asset-synthesis.js';
/** 面向分享阅读者的占位文案:该内联媒体未随分享携带(存量附件反推失败等)。 */
export const LEGACY_ATTACHMENT_PLACEHOLDER = '[附件暂不可见]';
/**
 * 把已解析的分享边界投影为 continuation manifest(v1 导出服务的纯计算部分)。
 * sidecar 只在非 Fork 来源时经 readSourceRecords 读取,读取失败的错误类型由调用方决定;
 * 历史不满足分享条件时抛 ContinuationHistoryValidationError。
 * sidecar 记录在 Server descriptor 里没有对应 occurrence 时不阻断导出,经 onMissingDescriptor 交给调用方。
 * 交付资产在正文里定位不到唯一 occurrence 时同样只少带这一个资产,经 onUnmatchedOccurrence 交给调用方。
 */
export async function buildShareContinuationManifest(input) {
    const { request, resolved: resolvedHistory } = input;
    const selectedHistory = historyRecordsToPersistedMessages(resolvedHistory.records);
    const resolvedCutoff = resolvedHistory.proof.resolvedBoundaryMessageId;
    if (!resolvedCutoff) {
        throw new ContinuationHistoryValidationError('source session has no persisted history');
    }
    const resolvedBoundaryTurnID = resolvedHistory.records.at(-1)?.turnId;
    if (!resolvedBoundaryTurnID) {
        throw new ContinuationHistoryValidationError('resolved boundary history record has no turn id');
    }
    // Fork 与源会话共用工作区,继承历史里的沙箱路径与 <deliver-assets> 引用
    // 原样有效,Server 也不为 Fork 冻结资产、不下发 source_assets。此时若仍按
    // sidecar 记录做 asset:// 改写,每条已记录的附件/交付物都会因缺 descriptor
    // 而整体导出失败(源会话交付过文件后 Fork 必挂)。Fork 不读 sidecar,
    // 也不产出 manifest 资产。
    const sourceRecords = request.origin === 'fork' ? [] : await input.readSourceRecords();
    // 存量兜底:分享功能上线前的附件消息没有 sidecar record,从消息本身
    // 反推补齐(仅本次导出的内存视图,不写回 sidecar)。反推不出的附件由
    // 投影层降级占位,不阻断导出。
    const synthesizedRecords = synthesizeLegacySourceAssetRecords({
        sessionId: request.session_id,
        persisted: selectedHistory,
        descriptors: request.source_assets,
        existingRecords: sourceRecords,
    });
    const draft = persistedMessagesToContinuationManifest(selectedHistory, request, [...sourceRecords, ...synthesizedRecords], input.onMissingDescriptor, input.onUnmatchedOccurrence);
    const parsed = ShareContinuationManifestSchema.safeParse({
        ...draft,
        source_history: continuationSourceHistory(resolvedHistory, resolvedBoundaryTurnID),
    });
    if (!parsed.success)
        throw new ContinuationHistoryValidationError(parsed.error.message);
    return parsed.data;
}
function continuationSourceHistory(resolvedHistory, resolvedBoundaryTurnID) {
    const proof = resolvedHistory.proof;
    const commonSourceHistory = {
        retained_end_exclusive: proof.retainedEndExclusive,
        resolved_boundary_message_id: proof.resolvedBoundaryMessageId,
        resolved_boundary_turn_id: resolvedBoundaryTurnID,
        execution_message_ids: proof.executionMessageIds,
        prefix_digest: proof.prefixDigest,
        settled: true,
    };
    if (resolvedHistory.selection.mode === 'entire_session') {
        if (proof.kind !== 'entire_history') {
            throw new ContinuationHistoryValidationError('entire-session selection did not resolve the entire current history');
        }
        return {
            ...commonSourceHistory,
            mode: resolvedHistory.selection.mode,
            artifact_id: proof.artifactId,
            artifact_scope: proof.artifactScope,
        };
    }
    if (proof.kind !== 'cut') {
        throw new ContinuationHistoryValidationError('user-anchor selection did not resolve a physical history cut');
    }
    return {
        ...commonSourceHistory,
        mode: resolvedHistory.selection.mode,
        artifact_id: `history-prefix:${proof.prefixDigest}`,
        artifact_scope: 'reachable_ancestor',
        user_message_id: resolvedHistory.selection.user_message_id,
        position: resolvedHistory.selection.position,
        effective_anchor_message_id: proof.anchorMessageId,
        effective_anchor_role: proof.anchorRole,
        effective_anchor_ordinal: proof.anchorOrdinal,
        cut_policy: proof.cutPolicy,
    };
}
export function persistedMessagesToContinuationManifest(persisted, request, sourceRecords = [], onMissingDescriptor, onUnmatchedOccurrence) {
    const working = structuredClone([...persisted]);
    const refsByMessage = new Map();
    const assets = [];
    const seenAssetIds = new Set();
    const descriptorByOccurrence = new Map();
    const recordByOccurrence = new Map();
    const duplicateRecordOccurrences = new Set();
    for (const record of sourceRecords) {
        const occurrenceKey = sourceOccurrenceKey(record);
        if (recordByOccurrence.has(occurrenceKey)) {
            duplicateRecordOccurrences.add(occurrenceKey);
            continue;
        }
        recordByOccurrence.set(occurrenceKey, record);
    }
    for (const descriptor of request.source_assets) {
        if (seenAssetIds.has(descriptor.asset_id)) {
            throw new ContinuationHistoryValidationError(`duplicate asset_id ${descriptor.asset_id}`);
        }
        seenAssetIds.add(descriptor.asset_id);
        const occurrenceKey = sourceOccurrenceKey(descriptor);
        if (descriptorByOccurrence.has(occurrenceKey)) {
            throw new ContinuationHistoryValidationError(`duplicate source asset occurrence ${occurrenceKey}`);
        }
        descriptorByOccurrence.set(occurrenceKey, descriptor);
        const record = recordByOccurrence.get(occurrenceKey);
        if (!record) {
            // Server also sends display-only attachments. Without a Runtime sidecar
            // occurrence they are not continuation inputs and must not enter the
            // manifest or its required asset ids.
            continue;
        }
        if (duplicateRecordOccurrences.has(occurrenceKey)) {
            throw new ContinuationHistoryValidationError(`sidecar record for source asset ${occurrenceKey} is ambiguous`);
        }
        validateSourceIdentity(descriptor, record);
    }
    for (const record of sourceRecords) {
        const messageExists = working.some((message) => message.message_id === record.history_message_id);
        if (!messageExists)
            continue;
        const occurrenceKey = sourceOccurrenceKey(record);
        if (duplicateRecordOccurrences.has(occurrenceKey)) {
            throw new ContinuationHistoryValidationError(`sidecar record for source asset ${occurrenceKey} is ambiguous`);
        }
        const descriptor = descriptorByOccurrence.get(occurrenceKey);
        if (!descriptor) {
            // Server 没有为这条 occurrence 下发 descriptor(没冻结到这份资产):只少带这一个资产,正文保留
            // 原样,同没有 sidecar 记录的 occurrence;不让整个会话因此无法分享。歧义与 binding 不一致
            // 会写错资产,仍然拒绝。
            onMissingDescriptor?.(record);
            continue;
        }
        try {
            replaceSourceOccurrence(working, descriptor, record);
        }
        catch (error) {
            // 交付资产定位不到唯一 occurrence(canonical 正文里还留着回写时剥离的 media,或是未归一的
            // 独立 <media>):只少带这一个资产,抛错前正文没有改动。用户附件仍然拒绝。
            if (descriptor.source_ref_kind !== 'deliver_asset' ||
                !(error instanceof ContinuationHistoryValidationError)) {
                throw error;
            }
            onUnmatchedOccurrence?.(record, error.message);
            continue;
        }
        const refs = refsByMessage.get(record.history_message_id) ?? [];
        refs.push(descriptor.asset_id);
        refsByMessage.set(record.history_message_id, refs);
        assets.push({
            asset_id: descriptor.asset_id,
            representation: record.representation,
            sha256: descriptor.sha256,
            size_bytes: descriptor.size_bytes,
            file_name: record.file_name,
            mime_type: record.mime_type,
        });
    }
    const projected = projectPortableHistory(working, request);
    const messages = [];
    for (const item of projected.messages) {
        if (item.kind === 'visible_message') {
            messages.push({ ...item, asset_refs: refsByMessage.get(item.source_message_id) ?? [] });
            continue;
        }
        if (item.kind === 'canonical_compaction_summary' || item.kind === 'portable_custom_context') {
            messages.push(item);
            continue;
        }
        const executions = [];
        for (const execution of item.executions) {
            executions.push({ ...execution, asset_refs: [] });
        }
        messages.push({
            ...item,
            assistant: {
                ...item.assistant,
                asset_refs: refsByMessage.get(item.assistant.source_message_id) ?? [],
            },
            executions,
        });
    }
    return {
        schema: SHARE_CONTINUATION_MANIFEST_SCHEMA,
        share_id: projected.share_id,
        sanitizer_version: projected.sanitizer_version,
        source_cutoff_message_id: projected.source_cutoff_message_id,
        assets,
        messages,
    };
}
function projectPortableHistory(persisted, request) {
    if (persisted.length === 0) {
        throw new ContinuationHistoryValidationError('source session has no persisted history');
    }
    const selected = persisted;
    const messages = [];
    for (let index = 0; index < selected.length; index += 1) {
        const entry = selected[index];
        if (!entry)
            break;
        const message = asRecord(entry.message, `message ${entry.message_id}`);
        const role = message.role;
        if (role === 'custom') {
            if (isProviderOmittedCustomMessage(message))
                continue;
            const customType = requiredString(message.customType, `message ${entry.message_id} customType`);
            const content = portableCustomContent(message.content, entry.message_id);
            messages.push({
                kind: 'portable_custom_context',
                source_message_id: entry.message_id,
                custom_type: customType,
                content,
                display: requiredBoolean(message.display, `message ${entry.message_id} display`),
                timestamp_ms: timestamp(message, entry.message_id),
            });
            continue;
        }
        if (role === 'compactionSummary') {
            const summary = requiredString(message.summary, `message ${entry.message_id} summary`);
            messages.push({
                kind: 'canonical_compaction_summary',
                source_message_id: entry.message_id,
                summary,
                tokens_before: optionalNonnegativeInteger(message.tokensBefore, `message ${entry.message_id} tokensBefore`),
                timestamp_ms: optionalNonnegativeInteger(message.timestamp, `message ${entry.message_id} timestamp`),
            });
            continue;
        }
        if (role === 'user') {
            const text = textOnlyContent(message.content, `message ${entry.message_id} content`);
            messages.push({
                kind: 'visible_message',
                source_message_id: entry.message_id,
                role: 'user',
                text,
                timestamp_ms: timestamp(message, entry.message_id),
                asset_refs: [],
            });
            continue;
        }
        if (role === 'assistant') {
            const content = assistantContent(message.content, entry.message_id);
            if (content.toolCalls.length === 0) {
                messages.push({
                    kind: 'visible_message',
                    source_message_id: entry.message_id,
                    role: 'assistant',
                    text: content.text,
                    timestamp_ms: timestamp(message, entry.message_id),
                    asset_refs: [],
                    ...assistantContextFields(message, content, entry.message_id),
                });
                continue;
            }
            const group = buildCompletedToolGroup(selected, index, entry, content);
            messages.push(group.item);
            index = group.lastIndex;
            continue;
        }
        if (role === 'toolResult' || role === 'bashExecution') {
            throw new ContinuationHistoryValidationError(`message ${entry.message_id} is an orphan ${String(role)}`);
        }
        throw new ContinuationHistoryValidationError(`message ${entry.message_id} has unsupported role ${String(role)}`);
    }
    const finalProjectedSourceID = lastProjectedSourceMessageID(messages);
    if (!finalProjectedSourceID) {
        throw new ContinuationHistoryValidationError('source session has no shareable history');
    }
    return {
        schema: SHARE_CONTINUATION_MANIFEST_SCHEMA,
        share_id: request.share_id,
        sanitizer_version: request.sanitizer_version,
        source_cutoff_message_id: finalProjectedSourceID,
        assets: [],
        messages,
    };
}
function lastProjectedSourceMessageID(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (!item)
            continue;
        if (item.kind !== 'completed_tool_group')
            return item.source_message_id;
        return item.executions.at(-1)?.source_message_id ?? item.assistant.source_message_id;
    }
    return undefined;
}
function isProviderOmittedCustomMessage(message) {
    const metadata = message.hostMetadata;
    return (typeof metadata === 'object' &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        Reflect.get(metadata, 'providerVisibility') === 'omit');
}
function buildCompletedToolGroup(selected, assistantIndex, assistantEntry, content) {
    let proof;
    try {
        proof = resolveCompletedToolGroup(persistedMessagesToHistoryRecords(selected), assistantIndex);
    }
    catch (error) {
        if (error instanceof HistoryToolGroupValidationError) {
            throw new ContinuationHistoryValidationError(`message ${assistantEntry.message_id} has an invalid tool group: ${error.message}`);
        }
        throw error;
    }
    const executions = [];
    for (const execution of proof.executions) {
        const entry = selected[execution.ordinal];
        if (!entry) {
            throw new ContinuationHistoryValidationError('tool group proof references a missing message');
        }
        const message = asRecord(entry.message, `message ${entry.message_id}`);
        if (execution.role === 'toolResult') {
            const contentText = textOnlyContent(message.content, `message ${entry.message_id} content`);
            executions.push({
                source_message_id: entry.message_id,
                message_type: 'toolResult',
                tool_call_id: execution.callId,
                status: 'completed',
                content_text: contentText,
                asset_refs: [],
                is_error: message.isError === true,
            });
        }
        else {
            if (message.excludeFromContext === true)
                continue;
            const output = requiredString(message.output, `message ${entry.message_id} output`);
            const exitCode = optionalInteger(message.exitCode, `message ${entry.message_id} exitCode`);
            executions.push({
                source_message_id: entry.message_id,
                message_type: 'bashExecution',
                tool_call_id: execution.callId,
                status: message.cancelled === true ? 'cancelled' : 'completed',
                content_text: output,
                asset_refs: [],
                ...(exitCode === undefined ? {} : { exit_code: exitCode }),
                truncated: message.truncated === true,
            });
        }
    }
    return {
        item: {
            kind: 'completed_tool_group',
            group_id: assistantEntry.message_id,
            assistant: {
                source_message_id: assistantEntry.message_id,
                text: content.text,
                asset_refs: [],
                tool_calls: content.toolCalls,
                ...assistantContextFields(asRecord(assistantEntry.message, `message ${assistantEntry.message_id}`), content, assistantEntry.message_id),
            },
            executions,
        },
        lastIndex: proof.endExclusive - 1,
    };
}
function optionalInteger(value, label) {
    if (value === undefined || value === null)
        return undefined;
    return requiredInteger(value, label);
}
function assistantContent(value, messageID) {
    if (!Array.isArray(value)) {
        return {
            structured: false,
            text: textOnlyContent(value, `message ${messageID} content`),
            toolCalls: [],
            contentLayout: [],
        };
    }
    const text = [];
    const toolCalls = [];
    const contentLayout = [];
    for (const block of value) {
        const item = asRecord(block, `message ${messageID} content block`);
        if (item.type === 'text') {
            const textBlock = requiredString(item.text, `message ${messageID} text block`);
            const textSignature = optionalString(item.textSignature, `message ${messageID} text signature`);
            text.push(textBlock);
            contentLayout.push({
                kind: 'text',
                text: textBlock,
                ...(textSignature ? { text_signature: textSignature } : {}),
            });
            continue;
        }
        if (item.type === 'thinking') {
            const thinking = requiredString(item.thinking, `message ${messageID} thinking block`);
            const thinkingSignature = optionalString(item.thinkingSignature, `message ${messageID} thinking signature`);
            contentLayout.push({
                kind: 'thinking',
                thinking,
                ...(thinkingSignature ? { thinking_signature: thinkingSignature } : {}),
                ...(item.redacted === true ? { redacted: true } : {}),
            });
            continue;
        }
        if (item.type !== 'toolCall') {
            throw new ContinuationHistoryValidationError(`message ${messageID} contains unsupported assistant content ${String(item.type)}`);
        }
        const args = asRecord(item.arguments, `message ${messageID} tool arguments`);
        const thoughtSignature = optionalString(item.thoughtSignature, `message ${messageID} tool thought signature`);
        const toolCallID = requiredString(item.id, `message ${messageID} tool id`);
        toolCalls.push({
            tool_call_id: toolCallID,
            tool_name: requiredString(item.name, `message ${messageID} tool name`),
            arguments: args,
            ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}),
        });
        contentLayout.push({ kind: 'tool_call', tool_call_id: toolCallID });
    }
    return { structured: true, text: text.join(''), toolCalls, contentLayout };
}
function assistantContextFields(message, content, messageID) {
    if (!content.structured)
        return {};
    const provider = requiredString(message.provider, `message ${messageID} provider`);
    const assistantContext = {
        api: requiredString(message.api, `message ${messageID} api`),
        provider,
        model: requiredString(message.model, `message ${messageID} model`),
        content_layout: content.contentLayout,
    };
    return { assistant_context: assistantContext };
}
function portableCustomContent(value, messageID) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value) || value.length === 0) {
        throw new ContinuationHistoryValidationError(`message ${messageID} custom content must be text`);
    }
    return value.map((block) => {
        const item = asRecord(block, `message ${messageID} custom content block`);
        if (item.type === 'image') {
            throw new ContinuationHistoryValidationError(`message ${messageID} custom image content has no portable asset binding`);
        }
        if (item.type !== 'text') {
            throw new ContinuationHistoryValidationError(`message ${messageID} custom content contains unsupported block ${String(item.type)}`);
        }
        const textSignature = optionalString(item.textSignature, `message ${messageID} custom text signature`);
        return {
            type: 'text',
            text: requiredString(item.text, `message ${messageID} text`),
            ...(textSignature ? { text_signature: textSignature } : {}),
        };
    });
}
function textOnlyContent(value, location) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value)) {
        throw new ContinuationHistoryValidationError(`${location} must be text-only`);
    }
    const text = [];
    for (const block of value) {
        const item = asRecord(block, `${location} block`);
        if (item.type === 'image') {
            // 走到投影还残留的内联媒体块:用户附件的图片/视频(有 sidecar/合成
            // record 的在 manifest 构建早期已替换掉,残留即无资产 provenance——
            // 存量 session 反推失败的兜底),以及工具结果里的截图等本就没有资产
            // 语义的媒体。不再 fail closed:降级成占位文本,字节不进 manifest,
            // 单个媒体块不阻断整体导出。
            text.push(LEGACY_ATTACHMENT_PLACEHOLDER);
            continue;
        }
        if (item.type !== 'text') {
            throw new ContinuationHistoryValidationError(`${location} contains an attachment or media`);
        }
        text.push(requiredString(item.text, `${location} text`));
    }
    return text.join('');
}
function timestamp(message, messageID) {
    const value = requiredInteger(message.timestamp, `message ${messageID} timestamp`);
    if (value < 0) {
        throw new ContinuationHistoryValidationError(`message ${messageID} timestamp is negative`);
    }
    return value;
}
function asRecord(value, location) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ContinuationHistoryValidationError(`${location} must be an object`);
    }
    return value;
}
function requiredString(value, location) {
    if (typeof value !== 'string') {
        throw new ContinuationHistoryValidationError(`${location} must be a string`);
    }
    return value;
}
function optionalString(value, location) {
    if (value === undefined)
        return undefined;
    return requiredString(value, location);
}
function requiredInteger(value, location) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new ContinuationHistoryValidationError(`${location} must be a safe integer`);
    }
    return value;
}
function requiredBoolean(value, location) {
    if (typeof value !== 'boolean') {
        throw new ContinuationHistoryValidationError(`${location} must be a boolean`);
    }
    return value;
}
function nonnegativeInteger(value, location) {
    const result = requiredInteger(value, location);
    if (result < 0) {
        throw new ContinuationHistoryValidationError(`${location} must be non-negative`);
    }
    return result;
}
function optionalNonnegativeInteger(value, location) {
    return value === undefined ? 0 : nonnegativeInteger(value, location);
}
function sourceOccurrenceKey(source) {
    return `${source.source_message_id}\0${source.source_ref_kind}\0${source.source_ref_ordinal}`;
}
function validateSourceIdentity(descriptor, record) {
    // 只核对 occurrence(调用方已按它匹配)和 binding，不比 sha256/size：指纹核对只是同一会话内的
    // 自检，附件始终来自 Server 为本会话冻结的那批，导入时仍按 Server 指纹核对下载结果。交付文件同一个
    // node 交付时和分享时的字节可以不同(AIGC 媒体本地是水印版)，用户附件的内联图在历史里可能是压缩
    // 副本。manifest 里的 sha256/size 取 Server descriptor 的值。
    if (descriptor.source_binding_id !== record.source_binding_id) {
        throw new ContinuationHistoryValidationError(`source asset ${descriptor.asset_id} identity does not match recorded occurrence`);
    }
}
function replaceSourceOccurrence(messages, descriptor, record) {
    const envelope = messages.find((message) => message.message_id === record.history_message_id);
    if (!envelope) {
        throw new ContinuationHistoryValidationError(`source asset ${descriptor.asset_id} message is outside continuation basis`);
    }
    const message = asRecord(envelope.message, `message ${envelope.message_id}`);
    if (descriptor.source_ref_kind === 'user_attachment') {
        if (message.role !== 'user') {
            throw new ContinuationHistoryValidationError('user attachment source is not a user message');
        }
        replaceUserAsset(message, descriptor.asset_id, record);
        return;
    }
    if (message.role !== 'assistant') {
        throw new ContinuationHistoryValidationError('deliver asset source is not an assistant message');
    }
    replaceDeliverAsset(message, descriptor.asset_id, record);
}
function replaceUserAsset(message, assetId, record) {
    if (record.representation === 'image_content') {
        if (!Array.isArray(message.content) || record.content_index === null) {
            throw new ContinuationHistoryValidationError(`image asset ${assetId} content is unavailable`);
        }
        const block = asRecord(message.content[record.content_index], `image asset ${assetId}`);
        if (block.type !== 'image' || typeof block.data !== 'string') {
            throw new ContinuationHistoryValidationError(`image asset ${assetId} content index is invalid`);
        }
        // 历史里的图片块可能是压缩副本，不再和原文件指纹比对；字节不进 manifest。
        message.content[record.content_index] = { type: 'text', text: '' };
        // 附件清单的 path 属性写着这张图的原路径，换成占位，导入时再换成接收方路径。只认完整属性，
        // 用户正文里提到同一路径时不能抢占清单的位置。老消息没有清单，找不到不报错。同一个文件在一条消息里
        // 附了两次时清单里有两个相同的属性：每条 record 只换第一处还没换的，和清单顺序一致。
        const attribute = `path="${record.sandbox_path}"`;
        for (let index = 0; index < message.content.length; index += 1) {
            const item = asRecord(message.content[index], `image asset ${assetId} content block`);
            if (item.type !== 'text' || typeof item.text !== 'string')
                continue;
            if (!item.text.includes(attribute))
                continue;
            message.content[index] = {
                ...item,
                text: item.text.replace(attribute, `path="asset://${assetId}"`),
            };
            break;
        }
        return;
    }
    if (record.representation !== 'sandbox_path' || !record.sandbox_path) {
        throw new ContinuationHistoryValidationError(`user asset ${assetId} representation is invalid`);
    }
    message.content = replacePathInContent(message.content, record.sandbox_path, `asset://${assetId}`);
}
function replacePathInContent(content, source, replacement) {
    if (typeof content === 'string')
        return replaceExactlyOnce(content, source, replacement);
    if (!Array.isArray(content)) {
        throw new ContinuationHistoryValidationError('user asset content is not text');
    }
    let replacements = 0;
    const output = [];
    for (const block of content) {
        const item = asRecord(block, 'user asset content block');
        if (item.type !== 'text' || typeof item.text !== 'string') {
            output.push(block);
            continue;
        }
        const count = countOccurrences(item.text, source);
        replacements += count;
        output.push({ ...item, text: item.text.replaceAll(source, replacement) });
    }
    if (replacements !== 1) {
        throw new ContinuationHistoryValidationError('user asset path is missing or ambiguous');
    }
    return output;
}
function replaceDeliverAsset(message, assetId, record) {
    if (record.representation !== 'deliver_asset' || !record.sandbox_path) {
        throw new ContinuationHistoryValidationError(`deliver asset ${assetId} representation is invalid`);
    }
    if (!Array.isArray(message.content)) {
        throw new ContinuationHistoryValidationError(`deliver asset ${assetId} content is unavailable`);
    }
    const content = message.content;
    const replacement = `asset://${assetId}`;
    const located = locateDeliverByOrdinal(content, assetId, record, replacement) ??
        locateDeliverBySource(content, assetId, record.sandbox_path, replacement);
    const old = asRecord(content[located.index], `deliver asset ${assetId} content block`);
    content[located.index] = { ...old, text: located.text };
}
/** 按记录的 ordinal 定位;该位置不存在或 src 对不上时返回 undefined,交给按 src 定位。 */
function locateDeliverByOrdinal(content, assetId, record, replacement) {
    let ordinalBase = 0;
    let located;
    for (let index = 0; index < content.length; index += 1) {
        const block = asRecord(content[index], `deliver asset ${assetId} content block`);
        if (block.type !== 'text' || typeof block.text !== 'string')
            continue;
        const result = replaceDeliverOccurrence(block.text, record.source_ref_ordinal - ordinalBase, record.sandbox_path, replacement);
        ordinalBase += result.occurrenceCount;
        if (result.mismatched)
            return undefined;
        if (!result.replaced)
            continue;
        if (located) {
            throw new ContinuationHistoryValidationError(`deliver asset ${assetId} occurrence is ambiguous`);
        }
        located = { index, text: result.text };
    }
    return located;
}
/**
 * 按 src 在 `<deliver-assets>` 块里找唯一的 media。ordinal 按回写后的正文编号(回写时剥离的 media
 * 不占号,与 archon-server 计数一致),canonical 正文里被剥离的 media 还在,ordinal 会对不上;src 唯一
 * 时就是这条记录的 occurrence。找不到或不唯一时拒绝,由调用方跳过这个资产。
 */
function locateDeliverBySource(content, assetId, expectedSource, replacement) {
    let matches = 0;
    let located;
    for (let index = 0; index < content.length; index += 1) {
        const block = asRecord(content[index], `deliver asset ${assetId} content block`);
        if (block.type !== 'text' || typeof block.text !== 'string')
            continue;
        const result = replaceDeliverSource(block.text, expectedSource, replacement);
        matches += result.count;
        if (result.count > 0)
            located = { index, text: result.text };
    }
    if (matches !== 1 || !located) {
        throw new ContinuationHistoryValidationError(`deliver asset ${assetId} occurrence is missing or ambiguous`);
    }
    return located;
}
const DELIVER_BLOCK_PATTERN = /<deliver-assets\b[^>]*>([\s\S]*?)<\/deliver-assets>/giu;
const DELIVER_MEDIA_PATTERN = /<media\s+([^>]*?)\/>/giu;
const DELIVER_SOURCE_PATTERN = /\bsrc\s*=\s*"([^"]+)"/iu;
function replaceDeliverOccurrence(text, targetOrdinal, expectedSource, replacement) {
    let occurrence = 0;
    let replaced = false;
    let mismatched = false;
    const output = text.replace(DELIVER_BLOCK_PATTERN, (block) => block.replace(DELIVER_MEDIA_PATTERN, (tag, attributes) => {
        const current = occurrence;
        occurrence += 1;
        if (current !== targetOrdinal)
            return tag;
        if (attributes.match(DELIVER_SOURCE_PATTERN)?.[1] !== expectedSource || replaced) {
            mismatched = true;
            return tag;
        }
        replaced = true;
        return tag.replace(DELIVER_SOURCE_PATTERN, `src="${replacement}"`);
    }));
    return { text: output, occurrenceCount: occurrence, replaced, mismatched };
}
function replaceDeliverSource(text, expectedSource, replacement) {
    let count = 0;
    const output = text.replace(DELIVER_BLOCK_PATTERN, (block) => block.replace(DELIVER_MEDIA_PATTERN, (tag, attributes) => {
        if (attributes.match(DELIVER_SOURCE_PATTERN)?.[1] !== expectedSource)
            return tag;
        count += 1;
        return tag.replace(DELIVER_SOURCE_PATTERN, `src="${replacement}"`);
    }));
    return { text: output, count };
}
function replaceExactlyOnce(value, source, replacement) {
    if (countOccurrences(value, source) !== 1) {
        throw new ContinuationHistoryValidationError('source asset path is missing or ambiguous');
    }
    return value.replace(source, replacement);
}
function countOccurrences(value, source) {
    if (!source)
        return 0;
    return value.split(source).length - 1;
}
//# sourceMappingURL=continuation-manifest.js.map