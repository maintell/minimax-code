import { snapshotPermissionInput, validatePermissionExecutionPlan, } from '@mavis/permission';
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
    };
}
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
                    sessionOwnedReadablePaths: [...(input.sessionOwnedReadablePaths ?? [])],
                    ...(input.nativeDeleteSnapshot !== undefined
                        ? { nativeDeleteSnapshot: input.nativeDeleteSnapshot }
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
/**
 * Only assignment semantics carry project approval: `session create` with a
 * project (results report back by default) and `session send` that reports
 * back. Bunny's assignment tools reach here mapped to these commands. An
 * ordinary send between sessions keeps the general policy.
 */
function needsAssignmentProjectPermission(input) {
    if (input.toolName !== 'mavis')
        return false;
    const args = input.toolInput.args;
    const record = typeof args === 'object' && args !== null ? args : undefined;
    if (input.toolInput.command === 'session create')
        return record !== undefined && Reflect.get(record, 'project') !== undefined;
    if (input.toolInput.command !== 'session send' || !record)
        return false;
    if (Reflect.get(record, 'report_back') !== true)
        return false;
    const target = Reflect.get(record, 'session_id');
    return target !== 'me' && target !== input.sessionId;
}
/**
 * Approving Bunny's own assignment tools saves the rule under that tool's name
 * (the approval keeps the original call), while `mavis` approvals save it
 * under `mavis`; the command pattern is the same, so both match.
 */
const ASSIGNMENT_RULE_TOOL_NAMES = new Set(['mavis', 'assignment_create', 'assignment_send']);
async function checkAssignmentPermission(host, ctx, input) {
    if (!needsAssignmentProjectPermission(input))
        return undefined;
    // Resolve the target and apply its project deny before any mode can allow:
    // as in the base engine, bypass and off never lift a deny.
    if (!host.assignmentTools?.resolveAssignmentProject)
        return { behavior: 'deny', reason: 'Assignment project resolver is unavailable' };
    let project;
    try {
        project = await host.assignmentTools.resolveAssignmentProject(input.sessionId, input.toolInput);
    }
    catch (error) {
        return {
            behavior: 'deny',
            reason: assignmentProjectError(error),
        };
    }
    if (!project)
        return { behavior: 'deny', reason: 'Assignment project could not be resolved' };
    const pattern = `${input.toolInput.command}:${project}`;
    const rules = await ctx.permissionRules.listRules({
        agentName: input.agentName,
        sessionId: input.sessionId,
    });
    const matching = rules.filter((rule) => ASSIGNMENT_RULE_TOOL_NAMES.has(rule.ruleValue.toolName.toLowerCase()) &&
        rule.ruleValue.matcher?.kind === 'command' &&
        rule.ruleValue.matcher.pattern === pattern);
    const denied = matching.find((rule) => rule.ruleBehavior === 'deny');
    if (denied)
        return { behavior: 'deny', reason: 'Assignment denied by project rule' };
    const mode = input.permissionMode ?? readLocalPermissionMode(ctx.configGetter().permissionMode);
    if (mode === 'bypassPermissions' || mode === 'off')
        return { behavior: 'allow', reason: 'Assignment allowed by permission mode' };
    if (matching.some((rule) => rule.ruleBehavior === 'allow'))
        return { behavior: 'allow', reason: 'Assignment allowed by project rule' };
    return {
        behavior: 'ask',
        reason: 'Approval is required to assign work to this project',
        ruleContents: [`mavis(${pattern})`],
        ruleMatchers: [{ kind: 'command', pattern }],
    };
}
function assignmentProjectError(error) {
    if (!(error instanceof Error))
        return 'Invalid assignment project';
    if ('candidates' in error)
        return JSON.stringify({ message: error.message, candidates: error.candidates });
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