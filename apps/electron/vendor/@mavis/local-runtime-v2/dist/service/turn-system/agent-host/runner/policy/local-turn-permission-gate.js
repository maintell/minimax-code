import { withPermissionExecutionPlan } from '@mavis/agent-tools';
import { assertAgentHostCapabilityAvailable } from '../../empty-dependencies.js';
import { SIDE_SESSION_APPROVAL_REASON, sideSessionRequiresApproval, } from './side-session-approval.js';
import { readPermissionToolRequest, } from './permission-tool-request.js';
import { createShellReadinessGuard } from './shell-readiness-guard.js';
function miniAppDeniedApprovalReason(toolName) {
    return `Nobody can answer this permission request: the Mini App that owns this Session registered no event listener for this run and has not opened the Session in a chat side panel. Continue without ${toolName} or explain what you need.`;
}
/**
 * V2-owned permission hook orchestration. The injected decision source owns
 * policy/rules and the approval port owns pending lifecycle, dedupe, UI and
 * persisted replies; this gate owns hook ordering, plan consumption and fail-closed mapping.
 */
export class LocalTurnPermissionGate {
    options;
    constructor(options) {
        this.options = options;
        assertAgentHostCapabilityAvailable('permission-decision-source', typeof options.decisions?.check === 'function');
    }
    async beforeToolCall(callInput) {
        const request = readPermissionToolRequest(callInput.toolContext, this.options.executionPlans?.snapshotInput);
        // The side-Session lookup runs before the built-in bypass so that a
        // mutation-capable built-in (write/edit/bash) cannot skip the mandatory
        // side-Session confirmation.
        const sideSession = await this.resolveSideSessionApprovalRequirement(callInput, request);
        if (sideSession?.block)
            return { ...sideSession.block, blockedBy: 'permission' };
        const sideApprovalRequired = sideSession?.approvalRequired === true;
        if (shouldSkipPermissionCheck(this.options, callInput)) {
            // Desktop's built-in tool policy owns these tools elsewhere; the
            // side-Session confirmation is the only gate-level requirement here.
            if (!sideApprovalRequired)
                return undefined;
            const blocked = await this.resolveSideSessionApproval(callInput, request);
            return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
        }
        // Resolve the Session's read grant once and carry it through every policy
        // check of this call, including the recheck after a Hook rewrites input.
        const input = {
            ...callInput,
            ...(await this.resolveSessionOwnedReadablePaths(callInput.sessionId)),
        };
        let decision = await checkPermissionDecision(this.options.decisions, input, request);
        if (sideApprovalRequired && decision.behavior === 'allow') {
            // A policy or mode auto-approval is not enough inside a side Session:
            // downgrade it to an ordinary ask so exactly one user approval happens.
            // Hook auto-approval eligibility is deliberately not granted.
            decision = {
                behavior: 'ask',
                reason: SIDE_SESSION_APPROVAL_REASON,
                ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
            };
        }
        const executionPlan = readDecisionExecutionPlan(decision, request.toolInput, this.options.executionPlans?.validate);
        const blocked = await this.resolveCheckedPermission(input, request, decision, executionPlan);
        // This trusted marker describes admission, not an error produced by tool execution.
        return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
    }
    /**
     * The runtime owns the Session's artifact layout, so the read grant for the
     * Session's own recoverable artifacts is resolved here — never derived from
     * the Session id inside the permission engine. A resolver failure must not
     * widen access: the Session keeps the ordinary protected behavior, and the
     * failure is logged so a missing grant is diagnosable.
     */
    async resolveSessionOwnedReadablePaths(sessionId) {
        const resolve = this.options.resolveSessionOwnedReadablePaths;
        if (!resolve)
            return {};
        try {
            const paths = await resolve(sessionId);
            return paths.length > 0 ? { sessionOwnedReadablePaths: paths } : {};
        }
        catch (error) {
            this.options.logger?.warn?.({ session_id: sessionId, error: boundedPermissionError(error) }, 'permission.session_owned_readable_paths_unavailable');
            return {};
        }
    }
    async resolveSideSessionApprovalRequirement(input, request) {
        const sideSessions = this.options.sideSessions;
        if (!sideSessions)
            return undefined;
        if (!sideSessionRequiresApproval({ toolName: request.toolName, toolSource: request.toolSource }))
            return undefined;
        // The lookup runs only for a tool that would need confirmation, so an
        // ordinary read in a side Session and every tool elsewhere pay nothing.
        try {
            return (await sideSessions.isSideSession(input.sessionId))
                ? { approvalRequired: true }
                : undefined;
        }
        catch {
            // Fail closed. A transient metadata lookup cannot prove this Session is
            // ordinary, and the unsafe alternative is an unconfirmed workspace
            // mutation racing the parent Turn.
            this.logEnforcement(input, request, {
                policy_behavior: 'deny',
                gate_result: 'blocked',
                decision_source: 'policy',
                rewrite_applied: false,
                side_session: true,
            });
            return {
                block: permissionBlock(request.toolName, `Could not verify whether this Session is a temporary side Session; ${request.toolName} was blocked before execution. Retry from the main Session.`, 'policy'),
            };
        }
    }
    /** One explicit user approval for a bypass-eligible built-in tool in a side Session. */
    async resolveSideSessionApproval(input, request) {
        const approval = await this.requestApproval(input, request, {
            behavior: 'ask',
            reason: SIDE_SESSION_APPROVAL_REASON,
        });
        if (approval === 'deny') {
            this.logEnforcement(input, request, {
                policy_behavior: 'ask',
                gate_result: 'blocked',
                decision_source: 'approval_or_abort',
                approval_decision: approval,
                rewrite_applied: false,
                side_session: true,
            });
            return permissionBlock(request.toolName, SIDE_SESSION_APPROVAL_REASON, 'user');
        }
        this.logEnforcement(input, request, {
            policy_behavior: 'ask',
            gate_result: 'proceed',
            decision_source: 'user_reply',
            approval_decision: approval,
            rewrite_applied: false,
            side_session: true,
        });
        return undefined;
    }
    async resolveCheckedPermission(input, request, decision, executionPlan) {
        if (decision.behavior === 'deny') {
            this.logEnforcement(input, request, {
                policy_behavior: 'deny',
                gate_result: 'blocked',
                decision_source: 'policy',
                rewrite_applied: false,
            });
            return permissionBlock(request.toolName, decision.reason, 'policy');
        }
        const approvalDecision = toApprovalDecision(decision, input.preToolPermission);
        if (!approvalDecision) {
            applyExecutionPlan(input.toolContext, executionPlan);
            this.logEnforcement(input, request, {
                policy_behavior: 'allow',
                gate_result: 'proceed',
                decision_source: 'policy',
                rewrite_applied: Boolean(executionPlan?.transforms.length),
                execution_plan_present: Boolean(executionPlan),
                transform_count: executionPlan?.transforms.length ?? 0,
            });
            return undefined;
        }
        if (preToolHookAllowsWithoutApproval(input, approvalDecision)) {
            applyExecutionPlan(input.toolContext, executionPlan);
            this.logEnforcement(input, request, {
                policy_behavior: 'ask',
                gate_result: 'proceed',
                decision_source: 'plugin_hook',
                approval_decision: 'allow',
                rewrite_applied: Boolean(executionPlan?.transforms.length),
                execution_plan_present: Boolean(executionPlan),
                transform_count: executionPlan?.transforms.length ?? 0,
            });
            return undefined;
        }
        return this.resolvePermissionPrompt(input, request, approvalDecision, executionPlan);
    }
    async resolvePermissionPrompt(input, request, approvalDecision, executionPlan) {
        const pluginDecision = await requestPluginPermissionDecision(input, request, approvalDecision.reason, approvalRuleContents(approvalDecision, request));
        const pluginBlock = toPluginBlock(request, pluginDecision);
        if (pluginBlock) {
            this.logEnforcement(input, request, {
                policy_behavior: 'ask',
                gate_result: 'blocked',
                decision_source: 'plugin_hook',
                rewrite_applied: false,
            });
            return pluginBlock;
        }
        if (pluginDecision.updatedPermissions?.length) {
            const mutationBlock = await this.applyPluginPermissionUpdates(input, request, pluginDecision);
            if (mutationBlock) {
                this.logEnforcement(input, request, {
                    policy_behavior: 'ask',
                    gate_result: 'blocked',
                    decision_source: 'plugin_hook',
                    rewrite_applied: false,
                });
                return mutationBlock;
            }
        }
        if (pluginDecision.updatedInput || pluginDecision.updatedPermissions?.length) {
            return this.resolveRewrittenPermission(input, pluginDecision, executionPlan);
        }
        return this.resolveApproval({
            input,
            request,
            decision: approvalDecision,
            pluginDecision,
            executionPlan,
        });
    }
    async applyPluginPermissionUpdates(input, request, pluginDecision) {
        const updates = pluginDecision.updatedPermissions;
        if (!updates?.length)
            return undefined;
        if (!input.cwd?.trim()) {
            return permissionBlock(request.toolName, 'Plugin Hook permission update has no trusted workspace identity.', 'policy');
        }
        const owner = this.options.mutations;
        if (!owner?.applyAtomic) {
            return permissionBlock(request.toolName, 'Plugin Hook requested permission updates, but this runtime cannot apply them.', 'policy');
        }
        try {
            await owner.applyAtomic({
                sessionId: input.sessionId,
                cwd: input.cwd,
                updates,
                ...(input.signal ? { signal: input.signal } : {}),
            });
            return undefined;
        }
        catch (error) {
            return permissionBlock(request.toolName, `Plugin Hook permission update was rejected: ${boundedPermissionError(error)}`, 'policy');
        }
    }
    async resolveRewrittenPermission(input, pluginDecision, previousPlan) {
        applyHookUpdatedInput(input.toolContext, pluginDecision.updatedInput);
        const request = readPermissionToolRequest(input.toolContext, this.options.executionPlans?.snapshotInput);
        const policyDecision = await checkPermissionDecision(this.options.decisions, input, request, previousPlan?.nativeDelete);
        const executionPlan = readDecisionExecutionPlan(policyDecision, request.toolInput, this.options.executionPlans?.validate);
        if (policyDecision.behavior === 'deny') {
            this.logEnforcement(input, request, {
                policy_behavior: 'deny',
                gate_result: 'blocked',
                decision_source: 'policy_recheck',
                rewrite_applied: false,
            });
            return permissionBlock(request.toolName, policyDecision.reason, 'policy');
        }
        const approvalDecision = toApprovalDecision(policyDecision, input.preToolPermission);
        if (!approvalDecision) {
            applyExecutionPlan(input.toolContext, executionPlan);
            this.logEnforcement(input, request, {
                policy_behavior: 'allow',
                gate_result: 'proceed',
                decision_source: 'policy_recheck',
                rewrite_applied: Boolean(executionPlan?.transforms.length),
                execution_plan_present: Boolean(executionPlan),
                transform_count: executionPlan?.transforms.length ?? 0,
            });
            return undefined;
        }
        return this.resolveApproval({
            input,
            request,
            decision: approvalDecision,
            pluginDecision,
            executionPlan,
        });
    }
    async resolveApproval(resolution) {
        const { input, request, decision, pluginDecision, executionPlan } = resolution;
        if (canPluginAutoApprove(pluginDecision, decision)) {
            applyExecutionPlan(input.toolContext, executionPlan);
            this.logEnforcement(input, request, {
                policy_behavior: 'ask',
                gate_result: 'proceed',
                decision_source: 'plugin_hook',
                approval_decision: 'allow',
                rewrite_applied: Boolean(executionPlan?.transforms.length),
                execution_plan_present: Boolean(executionPlan),
                transform_count: executionPlan?.transforms.length ?? 0,
            });
            return undefined;
        }
        const miniAppBlock = await this.resolveMiniAppApproval(input, request);
        if (miniAppBlock)
            return miniAppBlock;
        const approval = await this.requestApproval(input, request, decision);
        if (approval === 'deny') {
            this.logEnforcement(input, request, {
                policy_behavior: 'ask',
                gate_result: 'blocked',
                decision_source: 'approval_or_abort',
                approval_decision: approval,
                rewrite_applied: false,
            });
            return permissionBlock(request.toolName, decision.reason, 'user');
        }
        applyExecutionPlan(input.toolContext, executionPlan);
        this.logEnforcement(input, request, {
            policy_behavior: 'ask',
            gate_result: 'proceed',
            decision_source: 'user_reply',
            approval_decision: approval,
            rewrite_applied: Boolean(executionPlan?.transforms.length),
            execution_plan_present: Boolean(executionPlan),
            transform_count: executionPlan?.transforms.length ?? 0,
        });
        return undefined;
    }
    /** Looked up only when a tool would actually prompt; a Mini App ask nobody can answer is denied. */
    async resolveMiniAppApproval(input, request) {
        const miniAppApprovals = this.options.miniAppApprovals;
        const lineage = input.sessionLineage;
        if (!miniAppApprovals || isOrdinaryRootSession(lineage))
            return undefined;
        try {
            if (!(await miniAppApprovals.shouldDenyApproval(input.sessionId, lineage)))
                return undefined;
        }
        catch {
            return this.resolveMiniAppLookupFailure(input, request);
        }
        this.logEnforcement(input, request, {
            policy_behavior: 'ask',
            gate_result: 'blocked',
            decision_source: 'approval_or_abort',
            approval_decision: 'deny',
            rewrite_applied: false,
            miniapp_denied: true,
        });
        return permissionBlock(request.toolName, miniAppDeniedApprovalReason(request.toolName), 'policy');
    }
    resolveMiniAppLookupFailure(input, request) {
        if (input.sessionLineage?.miniApp !== true) {
            // Not known to be a Mini App root: a transient lookup failure must not deny an
            // ordinary Session's tool, so the normal approval flow asks the user.
            this.logEnforcement(input, request, { policy_behavior: 'ask', gate_result: 'proceed', miniapp_lookup_failed: true }, 'warn');
            return undefined;
        }
        // Fail closed. A prompt nobody can answer would hang the Mini App Turn.
        this.logEnforcement(input, request, {
            policy_behavior: 'deny',
            gate_result: 'blocked',
            decision_source: 'policy',
            rewrite_applied: false,
            miniapp_denied: true,
        });
        return permissionBlock(request.toolName, `Could not verify whether this Session can answer a permission request; ${request.toolName} was blocked instead of waiting for approval.`, 'policy');
    }
    logEnforcement(input, request, fields, level = 'info') {
        this.options.logger?.[level]?.({
            session_id: input.sessionId,
            turn_id: input.turnId,
            tool_call_id: request.toolCallId,
            tool_name: request.toolName,
            ...fields,
        }, 'permission.enforcement');
    }
    requestApproval(input, request, decision) {
        const approval = this.options.approval;
        if (!approval || typeof approval.request !== 'function') {
            assertAgentHostCapabilityAvailable('permission-approval-owner', false);
            throw new Error('Unreachable permission approval owner validation.');
        }
        const ruleContents = approvalRuleContents(decision, request);
        return requestApproval(approval, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            agentName: input.agentName,
            model: input.model,
            toolName: request.toolName,
            toolInput: request.toolInput,
            reason: decision.reason,
            ruleContents,
            ...(decision.ruleMatchers ? { ruleMatchers: decision.ruleMatchers } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.channelContext ? { channelContext: input.channelContext } : {}),
        });
    }
    /** Windows-only, per-Turn handshake; no command or permission check runs in its batch. */
    createShellReadinessGuard(input) {
        return createShellReadinessGuard({
            ...input,
            resolveAgentShell: this.options.resolveAgentShell,
        });
    }
}
function preToolHookAllowsWithoutApproval(input, decision) {
    return (input.preToolPermission?.behavior === 'allow' && decision.hookAutoApprovalEligible === true);
}
/** An ordinary root session or a SideChat (`parentSessionId: null`) can never be a Mini App ask. */
function isOrdinaryRootSession(lineage) {
    return lineage !== undefined && !lineage.miniApp && !lineage.parentSessionId;
}
function shouldSkipPermissionCheck(options, input) {
    return (options.enforceBuiltinTools !== true &&
        isBuiltinTool(input.toolContext.toolCall) &&
        input.preToolPermission?.behavior !== 'ask');
}
async function checkPermissionDecision(source, input, request, nativeDeleteSnapshot) {
    return validatePermissionDecision(await source.check({
        sessionId: input.sessionId,
        turnId: input.turnId,
        agentName: input.agentName,
        model: input.model,
        toolName: request.toolName,
        toolInput: request.toolInput,
        trustedExactWritePaths: [...(input.trustedExactWritePaths ?? [])],
        ...(input.sessionOwnedReadablePaths
            ? { sessionOwnedReadablePaths: [...input.sessionOwnedReadablePaths] }
            : {}),
        ...(nativeDeleteSnapshot !== undefined ? { nativeDeleteSnapshot } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    }));
}
function toApprovalDecision(decision, preToolPermission) {
    if (decision.behavior === 'ask') {
        return {
            ...decision,
            ...(preToolPermission?.behavior === 'ask' && preToolPermission.reason
                ? { reason: preToolPermission.reason }
                : {}),
        };
    }
    if (preToolPermission?.behavior !== 'ask')
        return undefined;
    return {
        behavior: 'ask',
        reason: preToolPermission.reason ?? 'Plugin Hook requested approval.',
        ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
    };
}
async function requestPluginPermissionDecision(input, request, reason, ruleContents) {
    return ((await input.beforeApproval?.({
        toolUseId: request.toolCallId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        reason,
        ruleContents,
        ...(input.signal ? { signal: input.signal } : {}),
    })) ?? { behavior: 'abstain' });
}
function approvalRuleContents(decision, request) {
    return decision.ruleContents?.length && decision.ruleContents.every(Boolean)
        ? [...decision.ruleContents]
        : deriveRuleContents(request.toolName, request.toolInput);
}
function canPluginAutoApprove(pluginDecision, productDecision) {
    if (pluginDecision.behavior !== 'allow')
        return false;
    if (pluginDecision.autoApproval === 'any_prompt')
        return true;
    return (pluginDecision.autoApproval === 'ordinary_only' &&
        productDecision.hookAutoApprovalEligible === true);
}
function toPluginBlock(request, decision) {
    if (decision.terminateAgent === true) {
        return {
            block: true,
            reason: decision.reason ?? `Agent stopped by Plugin Hook for ${request.toolName}`,
            terminateAgent: true,
        };
    }
    return decision.behavior === 'deny'
        ? {
            block: true,
            reason: decision.reason ?? `Permission denied by Plugin Hook for ${request.toolName}`,
        }
        : undefined;
}
function permissionBlock(toolName, reason, source) {
    return {
        block: true,
        reason: source === 'user'
            ? `Permission denied by user for ${toolName}: ${reason}`
            : `Permission denied for ${toolName}: ${reason}`,
    };
}
async function requestApproval(owner, input) {
    return validateApprovalDecision(await owner.request(input));
}
function validatePermissionDecision(decision) {
    if (!isPermissionDecisionObject(decision)) {
        throw new TypeError('Permission decision source returned an invalid decision.');
    }
    return decision;
}
function isPermissionDecisionObject(decision) {
    if (!decision || typeof decision !== 'object')
        return false;
    const behavior = Reflect.get(decision, 'behavior');
    const reason = Reflect.get(decision, 'reason');
    const executionPlan = Reflect.get(decision, 'executionPlan');
    const legacyRewrite = Reflect.get(decision, 'rewrittenInput');
    const ruleContents = Reflect.get(decision, 'ruleContents');
    const ruleMatchers = Reflect.get(decision, 'ruleMatchers');
    const hookAutoApprovalEligible = Reflect.get(decision, 'hookAutoApprovalEligible');
    return (isPermissionBehavior(behavior) &&
        typeof reason === 'string' &&
        isOptionalRecord(executionPlan) &&
        legacyRewrite === undefined &&
        isOptionalRuleContents(ruleContents) &&
        isOptionalRuleMatchers(ruleMatchers, ruleContents) &&
        isOptionalBoolean(hookAutoApprovalEligible));
}
function isOptionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
}
function isPermissionBehavior(value) {
    return value === 'allow' || value === 'deny' || value === 'ask';
}
function isOptionalRecord(value) {
    return (value === undefined || (Boolean(value) && typeof value === 'object' && !Array.isArray(value)));
}
function isOptionalRuleContents(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.every((rule) => typeof rule === 'string' && Boolean(rule.trim()))));
}
function isOptionalRuleMatchers(value, ruleContents) {
    if (value === undefined)
        return true;
    if (!Array.isArray(value) ||
        !Array.isArray(ruleContents) ||
        value.length !== ruleContents.length) {
        return false;
    }
    return value.every(isRuleMatcher);
}
function isRuleMatcher(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const kind = Reflect.get(value, 'kind');
    if (kind === 'tool')
        return true;
    const pattern = Reflect.get(value, 'pattern');
    if (kind === 'command')
        return isNonBlankString(pattern);
    if (kind !== 'path' || !isNonBlankString(pattern))
        return false;
    const actions = Reflect.get(value, 'actions');
    return isPermissionRuleActions(actions);
}
function isNonBlankString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
function isPermissionRuleActions(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const validActions = new Set(['read', 'write', 'delete', 'execute', 'network']);
    return value.every((action) => typeof action === 'string' && validActions.has(action));
}
function validateApprovalDecision(decision) {
    if (decision !== 'allowOnce' && decision !== 'allowAlways' && decision !== 'deny') {
        throw new TypeError('Permission approval owner returned an invalid decision.');
    }
    return decision;
}
function readDecisionExecutionPlan(decision, originalInput, validate) {
    if (decision.behavior === 'deny' || !decision.executionPlan)
        return undefined;
    if (!validate) {
        assertAgentHostCapabilityAvailable('permission-execution-plan-validator', false);
        throw new Error('Unreachable permission execution-plan validator validation.');
    }
    return validate(decision.executionPlan, originalInput);
}
function applyExecutionPlan(context, plan) {
    if (!plan)
        return;
    const target = readMutableRecord(context.args);
    for (const key of Reflect.ownKeys(target)) {
        if (!Reflect.deleteProperty(target, key)) {
            throw new TypeError('Permission gate could not replace the execution input.');
        }
    }
    Object.assign(target, plan.effectiveInput);
    withPermissionExecutionPlan(target, plan);
    if (context.args !== target)
        Object.assign(context, { args: target });
}
function applyHookUpdatedInput(context, updatedInput) {
    if (!updatedInput)
        return;
    const target = readMutableRecord(context.args);
    for (const key of Reflect.ownKeys(target)) {
        if (!Reflect.deleteProperty(target, key)) {
            throw new TypeError('Permission gate could not replace the Hook-updated input.');
        }
    }
    Object.assign(target, updatedInput);
    if (context.args !== target)
        Object.assign(context, { args: target });
}
function isBuiltinTool(toolCall) {
    const source = toolCall && typeof toolCall === 'object' ? Reflect.get(toolCall, 'source') : undefined;
    return source === 'builtin' || source === 'builtin-matrix';
}
function deriveRuleContents(toolName, input) {
    const direct = input.command ?? input.path ?? input.filePath ?? input.file_path ?? input.url ?? input.pattern;
    return typeof direct === 'string' && direct.trim() ? [direct.trim()] : [toolName];
}
function readMutableRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function boundedPermissionError(error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
//# sourceMappingURL=local-turn-permission-gate.js.map