import { isCloudSessionRead, readCloudSession } from './session-read-source.js';
import { deriveMediaKind, inferAssetMimeType } from '@mavis/shared';
import { getCloudDriveNodeId, isCommitIdTransportId } from '@mavis/shared/asset-markup';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import { isSideChatSendOrigin } from '@mavis/shared/sidechat-send-origin';
import { DriveNodeSource, DriveNodeType, InstalledPluginSource, PluginCapabilityType, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { MessageQueryServiceError, PeekContextServiceError, SessionInputSummaryServiceError, SessionUsageServiceError, SessionSourceQueryServiceError, isInlineDisplayDataUrl, } from '../../service/session-system/index.js';
import { AppError } from '../errors.js';
import { queryCollapseSteeringProjection } from '../conversation/query-collapse-identity.js';
import { projectPeerMessageOrigin } from '../conversation/peer-message-origin.js';
/** Owns generated Session content mapping and the message repair-fence workflow. */
export class SessionContentApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async getMessages(_context, request) {
        if (isCloudSessionRead(request.source))
            return readCloudSession(this.options.cloudReader
                ? () => this.options.cloudReader.getMessages(request.id, request, _context.signal)
                : undefined);
        try {
            const page = await this.readMessages({
                sessionId: request.id,
                ...(request.limit !== undefined ? { limit: request.limit } : {}),
                ...(request.before ? { before: request.before } : {}),
            });
            const queryCollapseViews = await this.readQueryCollapseViews(request.id, page.messages);
            const messages = await this.toSessionMessageViews(request.id, page.messages);
            const lastMsgId = messages.at(-1)?.msgId;
            return {
                messages,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                ...(lastMsgId ? { lastMsgId } : {}),
                hasMore: page.hasMore,
                queryCollapseViews: queryCollapseViews.map(toQueryCollapseView),
            };
        }
        catch (error) {
            if (error instanceof MessageQueryServiceError)
                throw messageApplicationError(error);
            throw error;
        }
    }
    async listSessionSourceHistory(_context, request) {
        try {
            const page = await this.options.sources.list({
                sessionId: request.id,
                ...(request.limit !== undefined ? { limit: request.limit } : {}),
                ...(request.before ? { before: request.before } : {}),
            });
            return {
                sourcedTurnCount: page.sourcedTurnCount,
                sourceCount: page.sourceCount,
                recentSources: page.recentSources.map(toSessionSourceRecordView),
                turns: page.turns.map((turn) => ({
                    turnId: turn.turnId,
                    sourceStartedAt: turn.sourceStartedAtMs,
                    sources: turn.sources.map(toSessionSourceRecordView),
                })),
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        }
        catch (error) {
            if (error instanceof SessionSourceQueryServiceError) {
                throw sourceHistoryApplicationError(error);
            }
            throw error;
        }
    }
    async getSessionSourceDetail(_context, request) {
        try {
            const detail = await this.options.sources.getToolDetail(request.id, request.msgId, request.toolCallId);
            return detail
                ? { detail: { msgId: detail.messageId, toolCall: toSessionToolCallView(detail.toolCall) } }
                : {};
        }
        catch (error) {
            if (error instanceof SessionSourceQueryServiceError) {
                throw sourceHistoryApplicationError(error);
            }
            throw error;
        }
    }
    async listSessionFiles(_context, request) {
        const page = await this.options.files.listSessionFiles({
            sessionId: request.id,
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
            ...(request.cursor ? { cursor: request.cursor } : {}),
        });
        return {
            nodes: page.files.map((file) => toDriveNode(request.id, file)),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async listSessionInputSummaries(_context, request) {
        try {
            const page = await this.options.inputSummaries.list({
                sessionId: request.id,
                ...(request.limit !== undefined ? { limit: request.limit } : {}),
                ...(request.before !== undefined ? { before: request.before } : {}),
            });
            return {
                summaries: page.summaries.map((summary) => ({
                    userInput: summary.userInput,
                    ...(summary.assistantResponse ? { assistantResponse: summary.assistantResponse } : {}),
                    ...(summary.artifacts.length > 0
                        ? { artifacts: summary.artifacts.map((file) => toDriveNode(request.id, file)) }
                        : {}),
                    fileChangeCount: summary.fileChangeCount,
                })),
                total: page.total,
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        }
        catch (error) {
            if (error instanceof SessionInputSummaryServiceError) {
                throw inputSummaryApplicationError(error);
            }
            throw error;
        }
    }
    async getSessionUsage(_context, request) {
        try {
            const { summary, rows } = await this.options.usage.readSession({
                sessionId: request.id,
                ...(request.fromMs !== undefined ? { from: request.fromMs } : {}),
                ...(request.toMs !== undefined ? { to: request.toMs } : {}),
            });
            return { summary, rows: rows.map(toUsageView) };
        }
        catch (error) {
            if (error instanceof SessionUsageServiceError) {
                throw new AppError(400, error.reason, error.message);
            }
            throw error;
        }
    }
    async getSessionUsageSummary(_context, request) {
        try {
            return await this.options.usage.summarizeSession({
                sessionId: request.id,
                ...(request.fromMs !== undefined ? { from: request.fromMs } : {}),
                ...(request.toMs !== undefined ? { to: request.toMs } : {}),
            });
        }
        catch (error) {
            if (error instanceof SessionUsageServiceError) {
                throw new AppError(400, error.reason, error.message);
            }
            throw error;
        }
    }
    async getPeekContext(_context, request) {
        try {
            return { context: await this.options.peekContext.getContext(request.id) };
        }
        catch (error) {
            if (error instanceof PeekContextServiceError) {
                throw new AppError(404, 'SESSION_NOT_FOUND', error.message);
            }
            throw error;
        }
    }
    async readMessages(input) {
        let page = await this.options.messages.list(input);
        // Normal history reads must not take the admission lock: concurrent sends
        // otherwise fail as "active Turn" even though no Turn exists. Mutating stale
        // compaction repair still re-reads and writes under the exclusive fence.
        if (this.options.staleCompactionRepair.needsRepair(page.messages)) {
            const repaired = await this.options.maintenance.tryRunExclusive(input.sessionId, async () => {
                const current = await this.options.messages.list(input);
                return {
                    ...current,
                    messages: await this.options.staleCompactionRepair.repair(input.sessionId, current.messages),
                };
            });
            if (repaired.acquired)
                page = repaired.value;
        }
        return {
            ...page,
            messages: await this.options.conversationActions.project({
                sessionId: input.sessionId,
                messages: page.messages,
                mutationActive: this.options.conversationMutation.isActive(input.sessionId),
            }),
        };
    }
    async toSessionMessageViews(sessionId, messages) {
        const sourceSessionIds = [
            ...new Set(messages.flatMap((message) => {
                const sourceSessionId = forkOriginSourceSessionId(message);
                return sourceSessionId ? [sourceSessionId] : [];
            })),
        ];
        const sourceSessions = this.options.forkOriginSessions
            ? await this.options.forkOriginSessions.getMany(sourceSessionIds)
            : [];
        const sourceTitles = new Map(sourceSessions.flatMap((session) => session ? [[session.sessionId, session.title ?? session.sessionId]] : []));
        return Promise.all(messages.map(async (message, index) => {
            const sourceSessionId = forkOriginSourceSessionId(message);
            if (!sourceSessionId)
                return toSessionMessageView(message);
            const sourceMessageId = await this.resolveForkSourceMessageId(sessionId, messages, index);
            return toSessionMessageView(message, {
                sourceMessageId,
                sourceTitle: sourceTitles.get(sourceSessionId) ?? sourceSessionId,
            });
        }));
    }
    async resolveForkSourceMessageId(sessionId, messages, originIndex) {
        const inPagePrevious = [...messages.slice(0, originIndex)]
            .reverse()
            .find((candidate) => !forkOriginSourceSessionId(candidate));
        const inPageMessageId = displayMessageId(inPagePrevious);
        if (inPageMessageId)
            return inPageMessageId;
        const originMessageId = displayMessageId(messages[originIndex]);
        if (!originMessageId)
            return '';
        const previousPage = await this.options.messages.list({
            sessionId,
            before: originMessageId,
            limit: 1,
        });
        return displayMessageId(previousPage.messages.at(-1)) ?? '';
    }
    async readQueryCollapseViews(sessionId, messages) {
        const queryKeys = queryKeysForMessages(messages);
        if (queryKeys.length === 0)
            return [];
        try {
            return await this.options.queryCollapse.listByKeys({ sessionId, queryKeys });
        }
        catch {
            return [];
        }
    }
}
function queryKeysForMessages(messages) {
    const queryKeys = new Set();
    for (const message of messages) {
        const queryKey = nonEmptyString(firstDefined([message.queryKey, message.query_key]));
        if (queryKey)
            queryKeys.add(queryKey);
    }
    return [...queryKeys];
}
/** Maps the compact persisted Fork relation and derives non-owned presentation fields. */
function forkOriginView(message, derived) {
    if (message.kind !== 'fork-origin' && message.displayKind !== 'fork-origin')
        return undefined;
    const origin = message.forkOrigin;
    if (!isRecord(origin))
        return undefined;
    const sourceSessionId = maybeString(firstDefined([origin.sourceSessionId, origin.source_session_id]));
    const legacySourceMessageId = maybeString(firstDefined([origin.sourceDisplayMessageId, origin.source_display_message_id]));
    if (!sourceSessionId)
        return undefined;
    return {
        sourceSessionId,
        sourceMessageId: derived?.sourceMessageId ?? legacySourceMessageId ?? '',
        sourceTitle: derived?.sourceTitle ??
            maybeString(firstDefined([origin.sourceTitleSnapshot, origin.source_title_snapshot])) ??
            sourceSessionId,
    };
}
function forkOriginSourceSessionId(message) {
    if (message.kind !== 'fork-origin' && message.displayKind !== 'fork-origin')
        return undefined;
    const origin = message.forkOrigin;
    if (!isRecord(origin))
        return undefined;
    return maybeString(firstDefined([origin.sourceSessionId, origin.source_session_id]));
}
function displayMessageId(message) {
    return message ? maybeString(firstDefined([message.msgId, message.msg_id])) : undefined;
}
/** Maps one persisted display message to the generated DesktopService view. */
export function toSessionMessageView(message, forkOriginPresentation) {
    const forkOrigin = forkOriginView(message, forkOriginPresentation);
    const queryKey = maybeString(firstDefined([message.queryKey, message.query_key]));
    return {
        msgId: maybeString(firstDefined([message.msgId, message.msg_id])) ?? '',
        parentMsgId: maybeString(firstDefined([message.parentMsgId, message.parent_msg_id])),
        turnId: maybeString(firstDefined([message.turnId, message.turn_id])),
        queryKey,
        timestamp: maybeNumber(message.timestamp),
        msgContent: maybeString(firstDefined([message.msgContent, message.msg_content])),
        msgType: maybeNumber(firstDefined([message.msgType, message.msg_type, message.messageType, message.message_type])),
        role: maybeString(message.role),
        thinkingContent: maybeString(firstDefined([message.thinkingContent, message.thinking_content])),
        thinkingDurationMs: maybeNumber(firstDefined([message.thinkingDurationMs, message.thinking_duration_ms])),
        finishReason: maybeString(firstDefined([message.finishReason, message.finish_reason])),
        toolCalls: asArray(firstDefined([message.toolCalls, message.tool_calls])).map(toSessionToolCallView),
        attachments: asArray(message.attachments).map(toAttachmentView),
        usage: toSessionMessageUsageView(message.usage),
        source: maybeString(message.source),
        sourceMessageId: maybeString(firstDefined([message.sourceMessageId, message.source_message_id])),
        kind: maybeString(message.kind),
        ...(isRecord(message.actions)
            ? {
                actions: {
                    fork: Boolean(message.actions.fork),
                    rewind: Boolean(message.actions.rewind),
                },
            }
            : {}),
        ...(forkOrigin ? { forkOrigin } : {}),
        originJson: toSessionMessageOriginJson(message),
        communicationInfosJson: jsonStringOrString(firstDefined([
            message.communicationInfosJson,
            message.communication_infos_json,
            message.communication_infos,
            message.communicationInfos,
        ])),
        rawJson: toSessionMessageRawJson(message, queryKey),
    };
}
/**
 * The generated view has no slots for request timing, context usage or derived
 * steered provenance. Preserve those facts through the opaque rawJson channel.
 */
function toSessionMessageRawJson(message, queryKey) {
    const steering = queryCollapseSteeringProjection(queryKey);
    let raw;
    if (steering.steered) {
        raw = jsonStringOrString({ ...message, ...steering });
    }
    else if (isRecord(firstDefined([message.contextUsage, message.context_usage])) ||
        (isRecord(message.usage) &&
            (message.usage.request_duration_ms !== undefined ||
                message.usage.decode_duration_ms !== undefined))) {
        raw = jsonStringOrString(message);
    }
    else {
        raw = jsonStringOrString(firstDefined([message.rawJson, message.raw_json]));
    }
    if (typeof message.editContent !== 'string')
        return raw;
    if (!raw)
        return JSON.stringify({ editContent: message.editContent });
    try {
        const parsed = JSON.parse(raw);
        if (isRecord(parsed))
            return JSON.stringify({ ...parsed, editContent: message.editContent });
    }
    catch {
        // Preserve an opaque legacy raw payload instead of replacing it.
    }
    return raw;
}
function toQueryCollapseView(state) {
    return {
        queryKey: state.queryKey,
        currentTurnId: state.currentTurnId,
        forceExpanded: state.forceExpanded,
        processingStartedAtMs: state.processingStartedAtMs,
        ...(state.processingFinishedAtMs !== undefined
            ? { processingFinishedAtMs: state.processingFinishedAtMs }
            : {}),
    };
}
/**
 * Adapts persisted Cron, background task, SideChat hand-back and peer Session provenance to the
 * legacy UI origin contract without exposing routing context.
 */
function toSessionMessageOriginJson(message) {
    const explicitOrigin = firstDefined([message.originJson, message.origin_json, message.origin]);
    if (explicitOrigin !== undefined)
        return jsonStringOrString(explicitOrigin);
    const sourceContext = firstDefined([message.sourceContext, message.source_context]);
    if (carriesSourceContextOrigin(message, sourceContext))
        return jsonStringOrString(sourceContext.origin);
    const peerOrigin = projectPeerMessageOrigin(message);
    if (peerOrigin)
        return jsonStringOrString(peerOrigin);
    if (maybeString(message.source) !== 'cron')
        return undefined;
    if (!isRecord(sourceContext))
        return undefined;
    const cronId = nonEmptyString(firstDefined([sourceContext.cronId, sourceContext.cron_id]));
    if (!cronId)
        return undefined;
    const runId = nonEmptyString(firstDefined([sourceContext.runId, sourceContext.run_id]));
    return jsonStringOrString({
        rawMeta: {
            cronId,
            ...(runId ? { runId } : {}),
        },
    });
}
/** Approved machine-owned message sources may carry their UI origin in sourceContext. */
function carriesSourceContextOrigin(message, sourceContext) {
    if (!isRecord(sourceContext))
        return false;
    return (maybeString(message.source) === 'background-task' ||
        isSideChatSendOrigin(sourceContext.origin) ||
        (message.source === 'questionnaire' &&
            isOrdinaryQuestionnaireResponseOrigin(sourceContext.origin)));
}
function messageApplicationError(error) {
    switch (error.reason) {
        case 'session-not-found':
            return new AppError(404, 'SESSION_NOT_FOUND', error.message);
        case 'data-corrupt':
            return new AppError(500, 'MESSAGE_DATA_CORRUPT', error.message);
    }
}
function inputSummaryApplicationError(error) {
    return new AppError(error.reason === 'session-not-found' ? 404 : 400, error.reason === 'session-not-found'
        ? 'SESSION_NOT_FOUND'
        : 'INVALID_SESSION_INPUT_SUMMARY_PAGINATION', error.message);
}
function sourceHistoryApplicationError(error) {
    return new AppError(error.reason === 'session-not-found' ? 404 : 400, error.reason === 'session-not-found'
        ? 'SESSION_NOT_FOUND'
        : 'INVALID_SESSION_SOURCE_PAGINATION', error.message);
}
function toSessionSourceRecordView(source) {
    return {
        sourceId: source.sourceId,
        resourceType: source.resourceType,
        resourceDataJson: source.resourceDataJson,
        resourceDataVersion: source.resourceDataVersion,
        msgId: source.messageId,
        toolCallId: source.toolCallId,
        resourceOrdinal: source.resourceOrdinal,
        createdAt: source.createdAtMs,
    };
}
function toSessionToolCallView(value) {
    const toolCall = asRecord(value);
    const pluginProvenances = toPluginCapabilityProvenanceViews(firstDefined([toolCall.pluginProvenances, toolCall.plugin_provenances]));
    return {
        toolName: maybeString(firstDefined([toolCall.toolName, toolCall.tool_name, toolCall.name])) ?? '',
        toolCallId: maybeString(firstDefined([toolCall.toolCallId, toolCall.tool_call_id, toolCall.id])) ?? '',
        toolCallStatus: maybeNumber(firstDefined([toolCall.toolCallStatus, toolCall.tool_call_status, toolCall.status])),
        toolCallArgs: jsonStringOrString(firstDefined([
            toolCall.toolCallArgsJson,
            toolCall.tool_call_args_json,
            toolCall.toolCallArgs,
            toolCall.tool_call_args,
            toolCall.input,
        ])),
        toolCallResultData: jsonStringOrString(firstDefined([
            toolCall.toolCallResultDataJson,
            toolCall.tool_call_result_data_json,
            toolCall.toolCallResultData,
            toolCall.tool_call_result_data,
            toolCall.result,
        ])),
        ...(pluginProvenances ? { pluginProvenances } : {}),
    };
}
function toPluginCapabilityProvenanceViews(value) {
    const provenances = asArray(value).flatMap((item) => {
        const provenance = toPluginCapabilityProvenanceView(item);
        return provenance ? [provenance] : [];
    });
    return provenances.length > 0 ? provenances : undefined;
}
function toPluginCapabilityProvenanceView(value) {
    if (!isRecord(value))
        return undefined;
    const pluginName = nonEmptyString(firstDefined([value.pluginName, value.plugin_name]));
    const pluginVersion = nonEmptyString(firstDefined([value.pluginVersion, value.plugin_version]));
    const source = toInstalledPluginSource(value.source);
    const capabilityType = toPluginCapabilityType(firstDefined([value.capabilityType, value.capability_type]));
    const capabilityName = nonEmptyString(firstDefined([value.capabilityName, value.capability_name]));
    if (!pluginName || source === undefined || capabilityType === undefined || !capabilityName) {
        return undefined;
    }
    const iconUrl = nonEmptyString(firstDefined([value.iconUrl, value.icon_url]));
    const darkIconUrl = nonEmptyString(firstDefined([value.darkIconUrl, value.dark_icon_url]));
    return {
        pluginName,
        ...(pluginVersion ? { pluginVersion } : {}),
        source,
        capabilityType,
        capabilityName,
        ...(iconUrl ? { iconUrl } : {}),
        ...(darkIconUrl ? { darkIconUrl } : {}),
    };
}
function toInstalledPluginSource(value) {
    if (value === InstalledPluginSource.OFFICIAL || value === 'OFFICIAL') {
        return InstalledPluginSource.OFFICIAL;
    }
    if (value === InstalledPluginSource.LOCAL || value === 'LOCAL') {
        return InstalledPluginSource.LOCAL;
    }
    return undefined;
}
function toPluginCapabilityType(value) {
    if (value === PluginCapabilityType.APP || value === 'APP')
        return PluginCapabilityType.APP;
    if (value === PluginCapabilityType.MCP || value === 'MCP')
        return PluginCapabilityType.MCP;
    if (value === PluginCapabilityType.SKILL || value === 'SKILL')
        return PluginCapabilityType.SKILL;
    return undefined;
}
function toSessionMessageUsageView(value) {
    if (!isRecord(value))
        return undefined;
    return {
        totalTokens: maybeNumber(firstDefined([value.totalTokens, value.total_tokens])),
        contextWindow: maybeNumber(firstDefined([value.contextWindow, value.context_window])),
        inputTokens: maybeNumber(firstDefined([value.inputTokens, value.input_tokens])),
        outputTokens: maybeNumber(firstDefined([value.outputTokens, value.output_tokens])),
        cacheRead: maybeNumber(firstDefined([value.cacheRead, value.cache_read])),
        cacheWrite: maybeNumber(firstDefined([value.cacheWrite, value.cache_write])),
    };
}
function toAttachmentView(value) {
    const attachment = asRecord(value);
    const meta = asRecord(attachment.meta);
    const local = asRecord(attachment.local);
    const cloud = asRecord(attachment.cloud);
    const filePath = firstDefined([
        attachment.filePath,
        attachment.file_path,
        local.filePath,
        local.file_path,
    ]);
    const dataUrl = firstDefined([
        attachment.dataUrl,
        attachment.data_url,
        local.dataUrl,
        local.data_url,
    ]);
    const assetId = firstDefined([
        attachment.assetId,
        attachment.asset_id,
        local.assetId,
        local.asset_id,
    ]);
    const desktopPath = firstDefined([
        attachment.desktopPath,
        attachment.desktop_path,
        local.desktopPath,
        local.desktop_path,
    ]);
    const fileName = firstDefined([
        attachment.fileName,
        attachment.file_name,
        meta.fileName,
        meta.file_name,
    ]);
    const mimeType = firstDefined([
        attachment.mimeType,
        attachment.mime_type,
        meta.mimeType,
        meta.mime_type,
    ]);
    return {
        meta: {
            attachmentType: maybeString(firstDefined([attachment.type, meta.attachmentType, meta.attachment_type])),
            fileName: maybeString(fileName),
            mimeType: maybeString(mimeType),
            sizeBytes: maybeNumber(firstDefined([meta.sizeBytes, meta.size_bytes])),
        },
        local: {
            assetId: maybeString(assetId),
            filePath: maybeString(filePath),
            desktopPath: maybeString(desktopPath),
            dataUrl: displayUrl(dataUrl),
        },
        cloud: {
            uploadId: maybeString(firstDefined([cloud.uploadId, cloud.upload_id])),
            driveNodeId: maybeString(firstDefined([cloud.driveNodeId, cloud.drive_node_id])),
            url: maybeString(cloud.url),
            dataUrl: displayUrl(firstDefined([cloud.dataUrl, cloud.data_url])),
        },
        previewUrl: displayUrl(firstDefined([attachment.previewUrl, attachment.preview_url])),
        status: maybeString(attachment.status),
    };
}
function displayUrl(value) {
    const url = maybeString(value);
    return isInlineDisplayDataUrl(url) ? undefined : url;
}
function toDriveNode(sessionId, file) {
    const metadata = parseAssetMetadata(file.dataJson);
    const driveNodeId = getCloudDriveNodeId({
        path: file.path,
        ...(metadata.driveNodeId ? { driveNodeId: metadata.driveNodeId } : {}),
        ...(metadata.artifactId ? { artifactId: metadata.artifactId } : {}),
    });
    const name = file.name?.trim() || fileBasename(file.path);
    const assetType = file.assetType ?? undefined;
    return {
        nodeId: driveNodeId ?? (isCommitIdTransportId(file.path) ? file.path.slice(10) : ''),
        nodeType: DriveNodeType.File,
        parentId: '',
        name,
        fileExt: fileExtension(file.name || '') || fileExtension(file.path),
        category: deriveCategory({ path: file.path, name, type: assetType }),
        mimeType: inferAssetMimeType({ path: file.path, name, type: assetType }) ?? '',
        cdnUrl: '',
        source: DriveNodeSource.AgentDeliverable,
        sessionId,
        createdAt: file.messageCreatedAtMs,
        updatedAt: file.messageCreatedAtMs,
        path: file.path,
    };
}
function toUsageView(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        agentName: row.agentName,
        frameworkType: row.frameworkType,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        ...(row.model ? { model: row.model } : {}),
        ts: row.ts,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        ...(row.costUsd !== null ? { costUsd: row.costUsd } : {}),
        ...(row.raw !== null ? { rawJson: row.raw } : {}),
    };
}
function deriveCategory(input) {
    const type = input.type?.trim().toLowerCase() ?? '';
    if (type === 'website')
        return 'website';
    const kind = deriveMediaKind(input);
    if (kind === 'image')
        return 'images';
    if (kind === 'video')
        return 'videos';
    if (kind === 'audio')
        return 'audio';
    const extension = fileExtension(input.name) || fileExtension(input.path);
    if (matchesFileCategory(PRESENTATION_TYPES, extension, type))
        return 'ppt';
    if (matchesFileCategory(SPREADSHEET_TYPES, extension, type))
        return 'excel';
    if (matchesFileCategory(DOCUMENT_TYPES, extension, type))
        return 'documents';
    return '';
}
function parseAssetMetadata(raw) {
    try {
        const value = JSON.parse(raw);
        if (!isRecord(value))
            return {};
        const driveNodeId = maybeString(firstDefined([value.driveNodeId, value.drive_node_id]));
        const artifactId = maybeString(firstDefined([value.artifactId, value.artifact_id]));
        return {
            ...(driveNodeId ? { driveNodeId } : {}),
            ...(artifactId ? { artifactId } : {}),
        };
    }
    catch {
        return {};
    }
}
function fileBasename(filePath) {
    const normalized = filePath.replace(/\\/gu, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}
function fileExtension(nameOrPath) {
    const base = fileBasename(nameOrPath.split('#')[0]?.split('?')[0] ?? nameOrPath);
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function firstDefined(values) {
    for (const value of values) {
        if (value !== undefined && value !== null)
            return value;
    }
    return undefined;
}
const PRESENTATION_TYPES = new Set(['ppt', 'pptx', 'key']);
const SPREADSHEET_TYPES = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const DOCUMENT_TYPES = new Set(['doc', 'docx', 'pdf', 'txt', 'md', 'markdown', 'html', 'htm']);
function matchesFileCategory(values, extension, type) {
    return values.has(extension) || values.has(type);
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function maybeString(value) {
    return typeof value === 'string' ? value : undefined;
}
function nonEmptyString(value) {
    const stringValue = maybeString(value)?.trim();
    return stringValue || undefined;
}
function maybeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function jsonStringOrString(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return undefined;
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=content-application.js.map