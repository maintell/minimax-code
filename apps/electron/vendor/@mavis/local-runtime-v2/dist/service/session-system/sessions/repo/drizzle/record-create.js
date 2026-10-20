import { normalizeSessionType } from './normalization.js';
export function recordFromCreate(input, nowMs) {
    const sessionType = normalizeSessionType(input.sessionType ?? 'branch');
    return {
        ...(input.agentShell ? { agentShell: input.agentShell } : {}),
        ...recordIdentityFields(input, sessionType),
        ...recordStateFields(input),
        ...recordErrorFields(input),
        ...recordModelFields(input),
        ...recordProvenanceFields(input, nowMs),
    };
}
function recordIdentityFields(input, sessionType) {
    return {
        sessionId: input.sessionId,
        agentName: input.agentName,
        workspaceDir: input.workspaceDir,
        runtime: input.runtime,
        sessionType,
        sessionKind: input.sessionKind ?? 'conversation',
        title: input.title ?? null,
        titleSource: input.titleSource ?? (input.title?.trim() ? 'manual' : 'default'),
        parentSessionId: input.parentSessionId ?? null,
        purpose: input.purpose,
        originCronId: input.originCronId,
        miniAppOrigin: input.miniAppOrigin,
        isDefaultWorkspace: input.isDefaultWorkspace,
        runLocation: input.runLocation,
        ...appModeFields(sessionType, input.appMode),
    };
}
function recordStateFields(input) {
    return {
        status: input.status ?? 'idle',
        archived: input.archived ?? false,
        visibility: input.visibility ?? 'visible',
        memoryPolicy: input.memoryPolicy,
    };
}
function recordErrorFields(input) {
    return {
        errorMessage: input.errorMessage,
        errorCode: input.errorCode,
        errorSource: input.errorSource,
        errorDetail: input.errorDetail,
        errorProviderId: input.errorProviderId,
    };
}
function recordModelFields(input) {
    return {
        effectiveModel: input.effectiveModel,
        effectiveModelVariant: input.effectiveModelVariant,
        effectiveModelThinking: input.effectiveModelThinking,
        effectiveModelContextWindow: input.effectiveModelContextWindow,
        effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens,
    };
}
function recordProvenanceFields(input, nowMs) {
    return {
        origin: input.origin,
        sideChatOrigin: input.sideChatOrigin,
        sessionOrigin: input.sessionOrigin,
        sessionDataVersion: input.sessionDataVersion,
        scratchpadPath: input.scratchpadPath,
        createdAtMs: input.createdAtMs ?? nowMs,
        updatedAtMs: input.updatedAtMs ?? nowMs,
    };
}
function appModeFields(sessionType, appMode) {
    if (sessionType === 'root' || appMode === undefined)
        return {};
    return { appMode };
}
//# sourceMappingURL=record-create.js.map