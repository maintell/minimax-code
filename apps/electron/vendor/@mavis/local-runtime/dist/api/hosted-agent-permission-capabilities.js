import { snapshotPermissionInput, validatePermissionExecutionPlan, } from '@mavis/permission';
import { buildLocalPermissionRuleContents, readLocalPermissionMode, safeJsonStringify, } from './host-helpers.js';
import { buildPermissionToolDescription } from './routes/permission-request-helpers.js';
import { requestLocalPermissionApproval, } from './routes/permissions.js';
/** Adapts v1 permission policy and approval ownership for hosted v2 Agent Turns. */
export function createHostedAgentPermissionCapabilities(host) {
    return {
        executionPlans: {
            snapshotInput: snapshotPermissionInput,
            validate: validatePermissionExecutionPlan,
        },
        decisions: {
            check: async (input) => {
                const ctx = host.permissionRouteContext();
                const decision = await ctx.permissionService.checkPermission({
                    toolName: input.toolName,
                    input: { ...input.toolInput },
                    agentName: input.agentName,
                    sessionId: input.sessionId,
                    permissionModeOverride: input.permissionMode ?? readLocalPermissionMode(ctx.configGetter().permissionMode),
                    trustedExactWritePaths: [...(input.trustedExactWritePaths ?? [])],
                });
                if (decision.behavior === 'deny') {
                    return { behavior: 'deny', reason: decision.reason };
                }
                if (decision.behavior === 'allow') {
                    return {
                        behavior: 'allow',
                        reason: decision.reason,
                        ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
                    };
                }
                const ruleMatchers = normalizeHostedPermissionRuleMatchers(decision.ruleMatchers);
                return {
                    behavior: 'ask',
                    reason: decision.reason,
                    ...(decision.ruleContents ? { ruleContents: decision.ruleContents } : {}),
                    ...(ruleMatchers ? { ruleMatchers } : {}),
                    ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
                    ...(decision.hookAutoApprovalEligible === true ? { hookAutoApprovalEligible: true } : {}),
                };
            },
        },
        approval: {
            request: (input) => {
                if (!host.supportsInteraction('permissionPrompt')) {
                    return Promise.reject(new Error('HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.'));
                }
                const origin = permissionOrigin(input.channelContext);
                return requestLocalPermissionApproval(host.permissionRouteContext(), {
                    sessionId: input.sessionId,
                    agentName: input.agentName,
                    turnId: input.turnId,
                    toolName: input.toolName,
                    toolInput: safeJsonStringify(input.toolInput),
                    toolDescription: buildPermissionToolDescription(input.toolInput),
                    ruleContents: input.ruleContents.length > 0
                        ? [...input.ruleContents]
                        : buildLocalPermissionRuleContents(input.toolName, input.toolInput),
                    ...(input.ruleMatchers ? { ruleMatchers: input.ruleMatchers } : {}),
                    persistWholeToolRuleOnReply: true,
                    reason: input.reason,
                    ...(origin ? { origin } : {}),
                }, input.signal);
            },
        },
        mutations: {
            applyAtomic: async (input) => {
                if (input.signal?.aborted)
                    throw abortPermissionMutation(input.signal.reason);
                await host.permissionRouteContext().permissionService.applyPluginHookPermissionUpdates({
                    sessionId: input.sessionId,
                    cwd: input.cwd,
                    updates: input.updates,
                });
            },
            clearSession: async (sessionId) => {
                await host
                    .permissionRouteContext()
                    .permissionService.clearPluginHookSessionPermissions(sessionId);
            },
        },
    };
}
function normalizeHostedPermissionRuleMatchers(matchers) {
    if (!matchers)
        return undefined;
    const normalized = [];
    for (const matcher of matchers) {
        if (matcher.kind === 'tool') {
            normalized.push({ kind: 'tool' });
        }
        else if (matcher.kind === 'command') {
            normalized.push({ kind: 'command', pattern: matcher.pattern });
        }
        else {
            if (!matcher.actions?.length)
                return undefined;
            normalized.push({ kind: 'path', pattern: matcher.pattern, actions: [...matcher.actions] });
        }
    }
    return normalized;
}
function abortPermissionMutation(reason) {
    const error = new Error(typeof reason === 'string' && reason ? reason : 'Plugin Hook permission update was aborted.');
    error.name = 'AbortError';
    return error;
}
function permissionOrigin(channelContext) {
    if (!channelContext?.platform.trim() ||
        !channelContext.clientName?.trim() ||
        !channelContext.chatId.trim()) {
        return undefined;
    }
    return {
        platform: channelContext.platform,
        clientName: channelContext.clientName,
        chatId: channelContext.chatId,
        ...(channelContext.threadId?.trim() ? { threadId: channelContext.threadId } : {}),
    };
}
//# sourceMappingURL=hosted-agent-permission-capabilities.js.map