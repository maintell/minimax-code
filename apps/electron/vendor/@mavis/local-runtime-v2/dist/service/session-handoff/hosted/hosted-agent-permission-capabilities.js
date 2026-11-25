import { ASSIGNMENT_RULE_TOOL_NAMES, assignmentApprovalCommand, needsAssignmentProjectApproval, } from '@mavis/agent-tools/namespaced-tools';
import { resolveWriteTargetLocation, snapshotPermissionInput, validatePermissionExecutionPlan, } from '@mavis/permission';
import { buildLocalPermissionRuleContents, readLocalPermissionMode, buildPermissionToolDescription, } from '../../permission/index.js';
import { safeJsonStringify } from '../../../infra/transport/host-http.js';
import { requestLocalPermissionApproval, } from '../../permission/index.js';
/** Adapts v1 permission policy and approval ownership for hosted v2 Agent Turns. */
/** Maps one permission verdict onto the hosted Agent decision contract. */
function toHostedPermissionDecision(decision) {
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
        ...(decision.permissionMode ? { permissionMode: decision.permissionMode } : {}),
    };
}
export function createHostedAgentPermissionCapabilities(host) {
    return {
        executionPlans: {
            resolveWriteTarget: resolveWriteTargetLocation,
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
                    sessionOwnedReadablePaths: [...(input.sessionOwnedReadablePaths ?? [])],
                    ...(input.trustedWorkspaceRoots?.length
                        ? { trustedAdditionalWorkingPaths: [...input.trustedWorkspaceRoots] }
                        : {}),
                    ...(input.nativeDeleteSnapshot !== undefined
                        ? { nativeDeleteSnapshot: input.nativeDeleteSnapshot }
                        : {}),
                    ...(input.trustedMcpRuleSubject
                        ? { trustedMcpRuleSubject: input.trustedMcpRuleSubject }
                        : {}),
                });
                if (decision.behavior === 'deny')
                    return toHostedPermissionDecision(decision);
                const assignment = await checkAssignmentPermission(host, ctx, input);
                return assignment ?? toHostedPermissionDecision(decision);
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
                    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
                    ...(input.parentToolDescription
                        ? { parentToolDescription: input.parentToolDescription }
                        : {}),
                    ...(input.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
                    ...(origin ? { origin } : {}),
                    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
                    ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
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
async function checkAssignmentPermission(host, ctx, request) {
    // Every route reads the tool's own name and its own arguments; nothing is
    // rewritten into a `mavis` command first.
    if (!needsAssignmentProjectApproval(request.toolName, request.toolInput, request.sessionId))
        return undefined;
    // Resolve the target and apply its project deny before any mode can allow:
    // as in the base engine, bypass and off never lift a deny.
    if (!host.assignmentTools?.resolveAssignmentProject)
        return { behavior: 'deny', reason: 'Assignment project resolver is unavailable' };
    let project;
    try {
        project = await host.assignmentTools.resolveAssignmentProject(request.sessionId, request.toolName, request.toolInput);
    }
    catch (error) {
        return {
            behavior: 'deny',
            reason: assignmentProjectError(error),
        };
    }
    if (!project)
        return { behavior: 'deny', reason: 'Assignment project could not be resolved' };
    const pattern = `${assignmentApprovalCommand(request.toolName)}:${project}`;
    const rules = await ctx.permissionRules.listRules({
        agentName: request.agentName,
        sessionId: request.sessionId,
    });
    const matching = rules.filter((rule) => ASSIGNMENT_RULE_TOOL_NAMES.has(rule.ruleValue.toolName.toLowerCase()) &&
        rule.ruleValue.matcher?.kind === 'command' &&
        rule.ruleValue.matcher.pattern === pattern);
    const denied = matching.find((rule) => rule.ruleBehavior === 'deny');
    if (denied)
        return { behavior: 'deny', reason: 'Assignment denied by project rule' };
    const mode = request.permissionMode ?? readLocalPermissionMode(ctx.configGetter().permissionMode);
    if (mode === 'bypassPermissions' || mode === 'off')
        return { behavior: 'allow', reason: 'Assignment allowed by permission mode' };
    if (matching.some((rule) => rule.ruleBehavior === 'allow'))
        return { behavior: 'allow', reason: 'Assignment allowed by project rule' };
    return {
        behavior: 'ask',
        reason: 'Approval is required to assign work to this project',
        // Saved under the tool's own name. The command pattern is the same for every
        // name in ASSIGNMENT_RULE_TOOL_NAMES, so this rule covers the other tools
        // that dispatch into the same project, exactly as a `mavis` rule did.
        ruleContents: [`${request.toolName}(${pattern})`],
        ruleMatchers: [{ kind: 'command', pattern }],
    };
}
function assignmentProjectError(error) {
    if (!(error instanceof Error))
        return 'Invalid assignment project';
    if ('candidates' in error)
        return JSON.stringify({
            ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
            message: error.message,
            candidates: error.candidates,
        });
    return error.message;
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