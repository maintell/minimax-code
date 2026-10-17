export function findPendingLocalPermissionRequest(pendingPermissionRequests, input) {
    const fingerprint = localPermissionRuleContentsFingerprint(input.ruleContents, input.ruleMatchers);
    for (const item of pendingPermissionRequests.values()) {
        if (item.sessionId === input.sessionId &&
            item.toolName === input.toolName &&
            item.agentName === input.agentName &&
            localPermissionRuleContentsFingerprint(item.ruleContents, item.ruleMatchers) === fingerprint) {
            return item;
        }
    }
    return undefined;
}
function localPermissionRuleContentsFingerprint(ruleContents, ruleMatchers) {
    const candidates = ruleContents.map((ruleContent, index) => JSON.stringify({ ruleContent, matcher: ruleMatchers?.[index] }));
    return JSON.stringify(candidates.sort());
}
/**
 * Derive the v1-style `toolDescription` from a tool call's input record.
 * Mirrors `agent-core` v1 `service.ts:431`:
 *   `typeof input.description === 'string' ? input.description : undefined`.
 *
 * Returning undefined lets the registration site decide how to render the
 * card subtitle (currently `input.toolDescription ?? input.toolName`).
 */
export function buildPermissionToolDescription(input) {
    const desc = input.description;
    return typeof desc === 'string' ? desc : undefined;
}
//# sourceMappingURL=permission-request-helpers.js.map