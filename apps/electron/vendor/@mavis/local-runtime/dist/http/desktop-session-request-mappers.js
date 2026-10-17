export function toQueueMessageBody(req) {
    const reviewRequest = req.reviewRequest?.scope === 'local_changes' ? { scope: 'local_changes' } : undefined;
    return {
        content: req.content,
        attachments: req.attachments?.map(toLocalAttachmentBody).filter(Boolean),
        ...(req.model ? { model: toLocalModelBody(req.model) } : {}),
        clientRequestId: req.clientRequestId,
        client_request_id: req.clientRequestId,
        expiresAt: req.expiresAt,
        expires_at: req.expiresAt,
        ...(reviewRequest
            ? {
                source: 'code_review',
                reviewRequest,
                review_request: reviewRequest,
            }
            : {}),
        ...(req.computerUse?.enable === true
            ? { computerUse: { enable: true }, computer_use: { enable: true } }
            : {}),
    };
}
export function toSendMessageBody(req) {
    const reviewRequest = req.reviewRequest ? { scope: req.reviewRequest.scope } : undefined;
    return {
        content: req.content,
        attachments: req.attachments?.map(toLocalAttachmentBody).filter(Boolean),
        ...(req.model ? { model: toLocalModelBody(req.model) } : {}),
        turnId: req.turnId,
        turn_id: req.turnId,
        clientIntent: req.clientIntent,
        client_intent: req.clientIntent,
        enable_team: req.enableTeam,
        reviewRequest,
        review_request: reviewRequest,
        ...(req.computerUse?.enable === true
            ? { computerUse: { enable: true }, computer_use: { enable: true } }
            : {}),
    };
}
export function toCreateSessionBody(req) {
    const runLocation = req.runLocation ? toLocalRunLocationBody(req.runLocation) : undefined;
    return {
        workspaceDir: req.workspaceDir,
        workspace_dir: req.workspaceDir,
        parentSessionId: req.parentSessionId,
        parent_session_id: req.parentSessionId,
        title: req.title,
        visibility: req.visibility,
        purpose: req.purpose,
        teamModeOff: req.teamModeOff,
        team_mode_off: req.teamModeOff,
        ...(req.model ? { model: toLocalModelBody(req.model) } : {}),
        appMode: req.appMode,
        runLocation,
        run_location: runLocation,
    };
}
function toLocalModelBody(model) {
    return {
        providerId: model.providerId,
        provider_id: model.providerId,
        modelId: model.modelId,
        model_id: model.modelId,
        variant: model.variant,
        reasoning: model.reasoning,
        ...(model.thinking !== undefined ? { thinking: toLocalThinkingBody(model.thinking) } : {}),
    };
}
function toLocalThinkingBody(thinking) {
    return {
        ...(thinking.effort !== undefined ? { effort: thinking.effort } : {}),
        ...(thinking.offBehavior !== undefined
            ? { offBehavior: thinking.offBehavior, off_behavior: thinking.offBehavior }
            : {}),
        ...(thinking.budgets !== undefined ? { budgets: { ...thinking.budgets } } : {}),
    };
}
function toLocalRunLocationBody(input) {
    return {
        mode: input.mode,
        worktreeDir: input.worktreeDir,
        worktree_dir: input.worktreeDir,
        branch: input.branch,
        newWorktreeBranch: input.newWorktreeBranch,
        new_worktree_branch: input.newWorktreeBranch,
        ...(input.newWorktreeBase !== undefined
            ? {
                newWorktreeBase: input.newWorktreeBase,
                new_worktree_base: input.newWorktreeBase,
            }
            : {}),
    };
}
function toLocalAttachmentBody(attachment) {
    const filePath = attachment.local?.filePath;
    const desktopPath = attachment.local?.desktopPath;
    const dataUrl = attachment.local?.dataUrl ?? attachment.cloud?.dataUrl;
    if (!filePath && !dataUrl)
        return undefined;
    return {
        type: attachment.meta?.attachmentType,
        filePath,
        file_path: filePath,
        desktopPath,
        desktop_path: desktopPath,
        dataUrl,
        data_url: dataUrl,
        fileName: attachment.meta?.fileName,
        file_name: attachment.meta?.fileName,
        mimeType: attachment.meta?.mimeType,
        mime_type: attachment.meta?.mimeType,
        assetId: attachment.local?.assetId,
        asset_id: attachment.local?.assetId,
    };
}
//# sourceMappingURL=desktop-session-request-mappers.js.map