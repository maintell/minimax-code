/**
 * Creates the `queued` row shared by every local subagent task so a foreground
 * run is as observable and as recoverable as a background one: it has a taskId
 * handle, an output log, and a row that startup reconciliation can mark `lost`.
 */
export function createLocalSubagentTaskRow(input) {
    const now = input.host.nowMs();
    return input.host.backgroundTaskService.create({
        taskId: input.taskId,
        kind: 'subagent',
        status: 'queued',
        ownerSessionId: input.ownerSessionId,
        description: input.taskInput.description,
        toolCallId: input.toolCtx.toolCallId,
        createdAt: now,
        updatedAt: now,
        metadata: {
            parentSessionId: input.ownerSessionId,
            parentTurnId: input.toolCtx.turnId,
            agentName: input.target.resolvedAgentName,
            requestedAgentName: input.target.requestedName,
            exactOwnerName: input.target.exactOwnerName,
            resolvedAgentName: input.target.resolvedAgentName,
            trustedBuiltin: input.target.trustedBuiltin,
            subTurnId: input.turnId,
            executionMode: input.executionMode,
            ...(input.target.canonicalRole ? { canonicalRole: input.target.canonicalRole } : {}),
        },
    });
}
//# sourceMappingURL=subagent-task-row.js.map