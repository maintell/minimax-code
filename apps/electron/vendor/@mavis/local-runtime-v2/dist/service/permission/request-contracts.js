export function readPermissionDecision(data) {
    const value = data.decision;
    if (typeof value !== 'string')
        return undefined;
    const aliases = {
        allow: 'allowOnce',
        'allow-always': 'allowAlways',
        'allow-for-agent': 'allowOnce',
        allowForAgent: 'allowOnce',
        allowAlways: 'allowAlways',
        allowOnce: 'allowOnce',
        deny: 'deny',
    };
    return aliases[value];
}
export function readLocalPermissionMode(value) {
    return value === 'default' ||
        value === 'acceptEdits' ||
        value === 'bypassPermissions' ||
        value === 'auto' ||
        value === 'off'
        ? value
        : 'auto';
}
export function serializePermissionRequest(item) {
    return {
        requestId: item.requestId,
        sessionId: item.sessionId,
        turnId: item.turnId,
        agentName: item.agentName,
        toolName: item.toolName,
        ruleContents: item.ruleContents,
        ...(item.toolInput ? { toolInput: item.toolInput } : {}),
        ...(permissionToolDescription(item)
            ? { toolDescription: permissionToolDescription(item) }
            : {}),
        ...(item.parentToolCallId ? { parentToolCallId: item.parentToolCallId } : {}),
        ...(item.parentToolDescription ? { parentToolDescription: item.parentToolDescription } : {}),
        ...(item.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
        reason: permissionReason(item),
        allowAlwaysSupported: item.ruleContents.length > 0 || item.persistWholeToolRuleOnReply === true,
        createdAt: item.createdAt,
    };
}
function permissionToolDescription(item) {
    return item.parentToolDescription ? `PTC: ${item.parentToolDescription}` : item.toolDescription;
}
function permissionReason(item) {
    return item.parentToolCallId ? `来自 PTC：${item.reason}` : item.reason;
}
//# sourceMappingURL=request-contracts.js.map