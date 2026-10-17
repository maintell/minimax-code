import { mapPluginCapabilityProvenanceViews } from './desktop-plugin-provenance-mapper.js';
import { asArray, asObject, asStringArray, isObject, jsonStringOrString, maybeBoolean, maybeNumber, maybeString, } from './desktop-session-mapper-support.js';
export { appendSearchParam, asArray, asObject, encodeSegment, } from './desktop-session-mapper-support.js';
export { toQueueMessageBody, toSendMessageBody, toCreateSessionBody, } from './desktop-session-request-mappers.js';
const SESSION_TYPE_VIEW = {
    Branch: 0,
    Root: 1,
};
const SESSION_STATUS_VIEW = {
    Idle: 0,
    Started: 1,
    Error: 2,
    Abort: 3,
};
export function mapOptionalSessionInfoView(value) {
    return isObject(value) ? mapSessionInfoView(value) : undefined;
}
export function mapSessionInfoView(value) {
    const obj = asObject(value);
    return {
        sessionId: maybeString(obj.sessionId ?? obj.session_id),
        agentName: maybeString(obj.agentName ?? obj.agent_name),
        sessionType: mapSessionType(obj.sessionType ?? obj.session_type),
        title: maybeString(obj.title),
        parentSessionId: maybeString(obj.parentSessionId ?? obj.parent_session_id),
        archived: maybeBoolean(obj.archived ?? obj.compressed),
        status: mapSessionStatus(obj.status),
        createdAt: maybeNumber(obj.createdAt ?? obj.created_at),
        updatedAt: maybeNumber(obj.updatedAt ?? obj.updated_at),
        model: mapOptionalModelInfoView(obj.model),
        teamMode: maybeBoolean(obj.teamMode ?? obj.team_mode),
        workspaceDir: maybeString(obj.workspaceDir ?? obj.workspace_dir),
        frameworkType: maybeString(obj.frameworkType ?? obj.framework_type),
        isDefaultWorkspace: maybeBoolean(obj.isDefaultWorkspace ?? obj.is_default_workspace),
        visibility: maybeString(obj.visibility),
        purpose: maybeString(obj.purpose),
        effectiveModel: maybeString(obj.effectiveModel ?? obj.effective_model),
        effectiveModelVariant: maybeString(obj.effectiveModelVariant ?? obj.effective_model_variant),
        lastActiveAt: maybeNumber(obj.lastActiveAt ?? obj.last_active_at),
        runLocation: mapOptionalRunLocationView(obj.runLocation ?? obj.run_location),
    };
}
export function mapSessionTreeNodeView(value) {
    const obj = asObject(value);
    const sessionSource = isObject(obj.session) ? obj.session : value;
    return {
        session: mapOptionalSessionInfoView(sessionSource),
        childSessions: asArray(obj.childSessions ?? obj.child_sessions).map(mapSessionTreeChildView),
    };
}
function mapSessionTreeChildView(value) {
    const obj = asObject(value);
    return {
        sessionId: maybeString(obj.sessionId ?? obj.session_id),
        agentName: maybeString(obj.agentName ?? obj.agent_name),
        frameworkType: maybeString(obj.frameworkType ?? obj.framework_type),
        title: maybeString(obj.title),
        createdAt: maybeNumber(obj.createdAt ?? obj.created_at),
        updatedAt: maybeNumber(obj.updatedAt ?? obj.updated_at),
        archived: maybeBoolean(obj.archived),
        compressed: maybeBoolean(obj.compressed),
        status: mapSessionStatus(obj.status),
    };
}
function mapSessionType(value) {
    if (value === SESSION_TYPE_VIEW.Root || value === SESSION_TYPE_VIEW.Branch)
        return value;
    if (value === 'root')
        return SESSION_TYPE_VIEW.Root;
    if (value === 'task' || value === 'branch')
        return SESSION_TYPE_VIEW.Branch;
    return undefined;
}
function mapSessionStatus(value) {
    const obj = asObject(value);
    const rawType = obj.statusType ?? obj.status_type ?? obj.type ?? value;
    let statusType = SESSION_STATUS_VIEW.Idle;
    if (rawType === SESSION_STATUS_VIEW.Idle ||
        rawType === SESSION_STATUS_VIEW.Started ||
        rawType === SESSION_STATUS_VIEW.Error ||
        rawType === SESSION_STATUS_VIEW.Abort) {
        statusType = rawType;
    }
    else {
        const normalized = maybeString(rawType)?.toLowerCase();
        if (normalized === 'started' || normalized === 'running') {
            statusType = SESSION_STATUS_VIEW.Started;
        }
        else if (normalized === 'error' || normalized === 'failed') {
            statusType = SESSION_STATUS_VIEW.Error;
        }
        else if (normalized === 'aborted' || normalized === 'abort' || normalized === 'interrupted') {
            statusType = SESSION_STATUS_VIEW.Abort;
        }
    }
    return {
        statusType,
        message: maybeString(obj.message),
        errorCode: maybeNumber(obj.errorCode ?? obj.error_code),
        errorSource: maybeString(obj.errorSource ?? obj.error_source),
        errorDetail: maybeString(obj.errorDetail ?? obj.error_detail),
        errorProviderId: maybeString(obj.errorProviderId ?? obj.error_provider_id),
    };
}
function mapOptionalRunLocationView(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    return {
        mode: maybeString(obj.mode),
        resolvedDir: maybeString(obj.resolvedDir ?? obj.resolved_dir),
        resolvedBranch: maybeString(obj.resolvedBranch ?? obj.resolved_branch),
        parentRepoDir: maybeString(obj.parentRepoDir ?? obj.parent_repo_dir),
        createdAt: maybeNumber(obj.createdAt ?? obj.created_at),
    };
}
function mapOptionalModelInfoView(value) {
    if (!isObject(value))
        return undefined;
    return mapModelInfoView(value);
}
/**
 * Tolerant reader for model roster entries (camelCase host shapes and
 * snake_case wire shapes). Extra host-only fields (e.g. `selected` from
 * `listLocalRuntimeModels`) are dropped — ModelInfoView is the response-only
 * IDL surface for session views.
 */
export function mapModelInfoView(value) {
    const obj = asObject(value);
    return {
        providerId: maybeString(obj.providerId ?? obj.provider_id),
        modelId: maybeString(obj.modelId ?? obj.model_id),
        variant: maybeString(obj.variant),
        displayName: maybeString(obj.displayName ?? obj.display_name),
        contextLimit: maybeNumber(obj.contextLimit ?? obj.context_limit),
        supportedVariants: asStringArray(obj.supportedVariants ?? obj.supported_variants),
        thinkingConfig: mapOptionalModelThinkingConfigView(obj.thinkingConfig ?? obj.thinking_config),
        reasoning: maybeBoolean(obj.reasoning),
        thinking: mapOptionalModelThinkingInput(obj.thinking),
    };
}
function mapOptionalModelThinkingInput(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    const budgets = isObject(obj.budgets) ? asObject(obj.budgets) : undefined;
    return {
        effort: maybeString(obj.effort),
        offBehavior: maybeString(obj.offBehavior ?? obj.off_behavior),
        ...(budgets
            ? {
                budgets: {
                    minimal: maybeNumber(budgets.minimal),
                    low: maybeNumber(budgets.low),
                    medium: maybeNumber(budgets.medium),
                    high: maybeNumber(budgets.high),
                },
            }
            : {}),
    };
}
/**
 * Roster entry mapper for the BYOK-facing `model_provider.ListModels` facade
 * (RC MODEL_LIST reuses it). Maps only the fields the local roster already
 * produces — same field set as `mapModelInfoView` — into the generated
 * `ModelInfo` shape (provider_id / model_id are required on the wire). BYOK
 * enrichment fields (provider_source / provider_kind / status / selected)
 * are intentionally not fabricated here.
 */
export function mapModelInfo(value) {
    const view = mapModelInfoView(value);
    return {
        ...view,
        providerId: view.providerId ?? '',
        modelId: view.modelId ?? '',
    };
}
function mapOptionalModelThinkingConfigView(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    return {
        mode: maybeString(obj.mode),
        defaultValue: maybeString(obj.defaultValue ?? obj.default_value),
    };
}
export function mapOptionalQueuedMessageItemView(value) {
    return isObject(value) ? mapQueuedMessageItemView(value) : undefined;
}
export function mapQueuedMessageItemView(value) {
    const obj = asObject(value);
    const rawReviewRequest = asObject(obj.reviewRequest ?? obj.review_request);
    const reviewRequest = maybeString(rawReviewRequest.scope) === 'local_changes'
        ? { scope: 'local_changes' }
        : undefined;
    return {
        itemId: maybeString(obj.itemId ?? obj.item_id) ?? '',
        sessionId: maybeString(obj.sessionId ?? obj.session_id) ?? '',
        status: maybeString(obj.status) ?? 'queued',
        source: maybeString(obj.source),
        content: maybeString(obj.content),
        attachments: asArray(obj.attachments).map(mapAttachmentView),
        modelInfo: mapOptionalModelInfoView(obj.modelInfo ?? obj.model_info ?? obj.model),
        createdAt: maybeNumber(obj.createdAt ?? obj.created_at),
        expiresAt: maybeNumber(obj.expiresAt ?? obj.expires_at),
        startedAt: maybeNumber(obj.startedAt ?? obj.started_at),
        finishedAt: maybeNumber(obj.finishedAt ?? obj.finished_at),
        failedReason: maybeString(obj.failedReason ?? obj.failed_reason),
        ...(reviewRequest ? { reviewRequest } : {}),
    };
}
export function mapSessionMessageView(value) {
    const obj = asObject(value);
    return {
        msgId: maybeString(obj.msgId ?? obj.msg_id) ?? '',
        parentMsgId: maybeString(obj.parentMsgId ?? obj.parent_msg_id),
        timestamp: maybeNumber(obj.timestamp),
        msgContent: maybeString(obj.msgContent ?? obj.msg_content),
        msgType: maybeNumber(obj.msgType ?? obj.msg_type ?? obj.messageType ?? obj.message_type),
        role: maybeString(obj.role),
        thinkingContent: maybeString(obj.thinkingContent ?? obj.thinking_content),
        thinkingDurationMs: maybeNumber(obj.thinkingDurationMs ?? obj.thinking_duration_ms),
        finishReason: maybeString(obj.finishReason ?? obj.finish_reason),
        toolCalls: asArray(obj.toolCalls ?? obj.tool_calls).map(mapSessionToolCallView),
        attachments: asArray(obj.attachments).map(mapAttachmentView),
        usage: mapSessionMessageUsageView(obj.usage),
        ...(isObject(obj.contextUsage ?? obj.context_usage) || isObject(obj.preparation_error)
            ? { rawJson: JSON.stringify(value) }
            : {}),
        source: maybeString(obj.source),
        sourceMessageId: maybeString(obj.sourceMessageId ?? obj.source_message_id),
        kind: maybeString(obj.kind),
        originJson: jsonStringOrString(obj.originJson ?? obj.origin_json ?? obj.origin),
        communicationInfosJson: jsonStringOrString(obj.communicationInfosJson ?? obj.communication_infos_json ?? obj.communicationInfos),
    };
}
function mapSessionToolCallView(value) {
    const obj = asObject(value);
    const pluginProvenances = mapPluginCapabilityProvenanceViews(obj.pluginProvenances ?? obj.plugin_provenances);
    return {
        toolName: maybeString(obj.toolName ?? obj.tool_name) ?? '',
        toolCallId: maybeString(obj.toolCallId ?? obj.tool_call_id) ?? '',
        toolCallStatus: maybeNumber(obj.toolCallStatus ?? obj.tool_call_status),
        toolCallArgs: jsonStringOrString(obj.toolCallArgsJson ?? obj.tool_call_args_json ?? obj.toolCallArgs ?? obj.tool_call_args),
        toolCallResultData: jsonStringOrString(obj.toolCallResultDataJson ??
            obj.tool_call_result_data_json ??
            obj.toolCallResultData ??
            obj.tool_call_result_data),
        ...(pluginProvenances ? { pluginProvenances } : {}),
    };
}
function mapSessionMessageUsageView(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    return {
        totalTokens: maybeNumber(obj.totalTokens ?? obj.total_tokens),
        contextWindow: maybeNumber(obj.contextWindow ?? obj.context_window),
        inputTokens: maybeNumber(obj.inputTokens ?? obj.input_tokens),
        outputTokens: maybeNumber(obj.outputTokens ?? obj.output_tokens),
        cacheRead: maybeNumber(obj.cacheRead ?? obj.cache_read),
        cacheWrite: maybeNumber(obj.cacheWrite ?? obj.cache_write),
    };
}
function mapAttachmentView(value) {
    const obj = asObject(value);
    const meta = asObject(obj.meta);
    const local = asObject(obj.local);
    const cloud = asObject(obj.cloud);
    const filePath = obj.filePath ?? obj.file_path ?? local.filePath ?? local.file_path;
    const desktopPath = obj.desktopPath ?? obj.desktop_path ?? local.desktopPath ?? local.desktop_path;
    const dataUrl = obj.dataUrl ?? obj.data_url ?? local.dataUrl ?? local.data_url;
    const assetId = obj.assetId ?? obj.asset_id ?? local.assetId ?? local.asset_id;
    const fileName = obj.fileName ?? obj.file_name ?? meta.fileName ?? meta.file_name;
    const mimeType = obj.mimeType ?? obj.mime_type ?? meta.mimeType ?? meta.mime_type;
    return {
        meta: {
            attachmentType: maybeString(obj.type ?? meta.attachmentType ?? meta.attachment_type),
            fileName: maybeString(fileName),
            mimeType: maybeString(mimeType),
            sizeBytes: maybeNumber(meta.sizeBytes ?? meta.size_bytes),
        },
        local: {
            assetId: maybeString(assetId),
            filePath: maybeString(filePath),
            desktopPath: maybeString(desktopPath),
            dataUrl: maybeString(dataUrl),
        },
        cloud: {
            uploadId: maybeString(cloud.uploadId ?? cloud.upload_id),
            driveNodeId: maybeString(cloud.driveNodeId ?? cloud.drive_node_id),
            url: maybeString(cloud.url),
            dataUrl: maybeString(cloud.dataUrl ?? cloud.data_url),
        },
        previewUrl: maybeString(obj.previewUrl ?? obj.preview_url),
        status: maybeString(obj.status),
    };
}
export function mapTokenUsageSummaryView(value) {
    if (!isObject(value))
        return undefined;
    const obj = asObject(value);
    return {
        inputTokens: maybeNumber(obj.inputTokens ?? obj.input_tokens),
        outputTokens: maybeNumber(obj.outputTokens ?? obj.output_tokens),
        reasoningTokens: maybeNumber(obj.reasoningTokens ?? obj.reasoning_tokens),
        cacheReadTokens: maybeNumber(obj.cacheReadTokens ?? obj.cache_read_tokens),
        cacheWriteTokens: maybeNumber(obj.cacheWriteTokens ?? obj.cache_write_tokens),
        totalTokens: maybeNumber(obj.totalTokens ?? obj.total_tokens),
        costUsd: maybeNumber(obj.costUsd ?? obj.cost_usd),
        turns: maybeNumber(obj.turns),
    };
}
export function mapTokenUsageRowView(value) {
    const obj = asObject(value);
    return {
        id: maybeNumber(obj.id),
        sessionId: maybeString(obj.sessionId ?? obj.session_id),
        agentName: maybeString(obj.agentName ?? obj.agent_name),
        frameworkType: maybeString(obj.frameworkType ?? obj.framework_type),
        turnId: maybeString(obj.turnId ?? obj.turn_id),
        model: maybeString(obj.model),
        ts: maybeNumber(obj.ts),
        inputTokens: maybeNumber(obj.inputTokens ?? obj.input_tokens),
        outputTokens: maybeNumber(obj.outputTokens ?? obj.output_tokens),
        reasoningTokens: maybeNumber(obj.reasoningTokens ?? obj.reasoning_tokens),
        cacheReadTokens: maybeNumber(obj.cacheReadTokens ?? obj.cache_read_tokens),
        cacheWriteTokens: maybeNumber(obj.cacheWriteTokens ?? obj.cache_write_tokens),
        costUsd: maybeNumber(obj.costUsd ?? obj.cost_usd),
    };
}
export function mapFileDiffInfoView(value) {
    const obj = asObject(value);
    const patch = asObject(obj.patch);
    return {
        file: maybeString(obj.file) ?? '',
        additions: maybeNumber(obj.additions) ?? 0,
        deletions: maybeNumber(obj.deletions) ?? 0,
        status: maybeString(obj.status),
        diff: maybeString(obj.diff),
        patch: isObject(obj.patch)
            ? {
                oldFileName: maybeString(patch.oldFileName ?? patch.old_file_name) ?? '',
                newFileName: maybeString(patch.newFileName ?? patch.new_file_name) ?? '',
                hunks: asArray(patch.hunks).map((item) => {
                    const hunk = asObject(item);
                    return {
                        oldStart: maybeNumber(hunk.oldStart ?? hunk.old_start) ?? 0,
                        oldLines: maybeNumber(hunk.oldLines ?? hunk.old_lines) ?? 0,
                        newStart: maybeNumber(hunk.newStart ?? hunk.new_start) ?? 0,
                        newLines: maybeNumber(hunk.newLines ?? hunk.new_lines) ?? 0,
                        lines: asStringArray(hunk.lines),
                    };
                }),
            }
            : undefined,
        previewState: maybeString(obj.previewState ?? obj.preview_state),
        external: maybeBoolean(obj.external),
    };
}
export function mapTurnDiffFields(value) {
    const obj = asObject(value);
    const fileChanges = obj.fileChanges ?? obj.file_changes;
    return {
        fileChanges: asArray(fileChanges).map(mapFileDiffInfoView),
        sourceMessageId: maybeString(obj.sourceMessageId ?? obj.source_message_id),
        changeSetId: maybeString(obj.changeSetId ?? obj.change_set_id),
        status: maybeString(obj.status),
        revertedAt: maybeNumber(obj.revertedAt ?? obj.reverted_at),
        undoable: maybeBoolean(obj.undoable),
        canUndo: maybeBoolean(obj.canUndo ?? obj.can_undo),
        canReapply: maybeBoolean(obj.canReapply ?? obj.can_reapply),
    };
}
export function mapTurnDiffView(value) {
    const view = mapTurnDiffFields(value);
    if ((view.fileChanges?.length ?? 0) === 0 &&
        !view.sourceMessageId &&
        !view.changeSetId &&
        !view.status) {
        return undefined;
    }
    return view;
}
export function mapRequestCompactionResp(value) {
    const obj = asObject(value);
    return {
        success: maybeBoolean(obj.success) ?? false,
        sessionId: maybeString(obj.sessionId ?? obj.session_id),
        compactionId: maybeString(obj.compactionId ?? obj.compaction_id),
        messagesBefore: maybeNumber(obj.messagesBefore ?? obj.messages_before),
        messagesAfter: maybeNumber(obj.messagesAfter ?? obj.messages_after),
        tokensBefore: maybeNumber(obj.tokensBefore ?? obj.tokens_before),
        tokensAfter: maybeNumber(obj.tokensAfter ?? obj.tokens_after),
        error: maybeString(obj.error),
        code: maybeString(obj.code),
    };
}
//# sourceMappingURL=desktop-session-mappers.js.map