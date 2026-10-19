import { GLOBAL_SCOPE_KEY } from './contracts.js';
export const accessPolicy = {
    resolve(input) {
        if (!input.contextAvailable) {
            return { status: 'scope-unresolved' };
        }
        return {
            status: 'resolved',
            scopeKey: GLOBAL_SCOPE_KEY,
            annotations: {
                ...(input.agentName ? { agentName: input.agentName } : {}),
                ...(input.projectName ? { projectName: input.projectName } : {}),
                ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
            },
        };
    },
    evaluate(input) {
        const reasons = collectAccessReasons(input);
        const eligible = input.config.active && isEpochEligible(input);
        const canGenerate = input.config.writeEnabled && eligible;
        const canRecall = input.config.recallEnabled && eligible;
        const canManage = true;
        return { canGenerate, canRecall, canManage, reasons };
    },
};
function collectAccessReasons(input) {
    const reasons = [];
    if (!input.config.active || !input.config.writeEnabled)
        reasons.push('generation-disabled');
    if (!input.config.active || !input.config.recallEnabled)
        reasons.push('recall-disabled');
    if (input.exclusionReason !== undefined)
        reasons.push('external-context-excluded');
    if (!input.rootConversation)
        reasons.push('session-not-root');
    if (input.sessionCreatedAtMs <= input.resetAtMs)
        reasons.push('pre-reset-epoch');
    return reasons;
}
function isEpochEligible(input) {
    return (input.exclusionReason === undefined &&
        input.rootConversation &&
        input.sessionCreatedAtMs > input.resetAtMs);
}
//# sourceMappingURL=access-policy.js.map