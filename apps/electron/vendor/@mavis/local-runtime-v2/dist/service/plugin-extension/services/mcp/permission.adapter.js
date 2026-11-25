/**
 * Plugin calls go through the same permission facade as the agent, attributed with the rule
 * subject and marked as having no turn, so an auto-mode ask is not sent to the classifier.
 */
export function createLocalMcpPermissionDecider(permission) {
    return {
        async decide(input) {
            const verdict = await permission.checkPermission({
                toolName: input.toolRuntimeName,
                input: { ...input.args },
                sessionId: input.sessionId,
                trustedMcpRuleSubject: input.subject,
                trustedWithoutTurn: true,
            });
            return verdict.behavior;
        },
        async approve(input) {
            const decision = await permission.requestApproval({
                pluginId: input.pluginId,
                sessionId: input.sessionId,
                turnId: `ext:${input.pluginId}:${input.callId}`,
                toolName: input.toolRuntimeName,
                toolInput: { ...input.args },
                reason: `来自插件 ${input.pluginId}`,
                ...(input.signal ? { signal: input.signal } : {}),
            });
            return decision === 'deny' ? 'deny' : 'allow';
        },
    };
}
//# sourceMappingURL=permission.adapter.js.map