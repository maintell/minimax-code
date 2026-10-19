import { isRuntimeToolInputValid } from '@mavis/agent-core/tools';
import { getBrowserHostBinding } from '../assembly/host-capability/browser.js';
import { composePluginHookToolResultContent, emitLocalPluginHookWarnings, localPluginHookCoordinator as pluginHookCoordinator, mergePluginHookContext, } from '../assembly/local-turn-plugin-hooks.js';
import { authorizeDelegatedToolReference, resolveDelegatedToolTarget, revokeDelegatedToolReferenceAuthorization, } from '../assembly/local-turn-plugin-capabilities.js';
import { buildCompatiblePostToolResponse, buildCodexPostToolResponse } from '../tools/index.js';
import { successfulTaskOutputReadTaskId, successfulTerminalTaskOutputReadTaskId, } from './task-output-read.js';
export function createControlledToolHooks(options) {
    const { input, permissionGuard, pendingToolResultTailClaims, readTaskOutputTaskIds, toolsDisabled, toolSafetyGuard, toolPolicyGuard, finalizeToolResultForHistory, } = options;
    const pluginToolContexts = new Map();
    const pluginToolStartedAtMs = new Map();
    const delegatedToolCalls = new Map();
    const seenToolCallIds = new Set();
    return {
        beforeToolCallHook: [
            async (context, signal) => {
                const toolCallId = context.toolCall.id;
                if (seenToolCallIds.has(toolCallId)) {
                    return {
                        block: true,
                        reason: `Duplicate tool call id is not allowed within one turn: ${toolCallId}`,
                    };
                }
                seenToolCallIds.add(toolCallId);
                const prepared = prepareDelegatedToolCall(input, delegatedToolCalls, context);
                if (prepared.decision)
                    return prepared.decision;
                const effective = prepared.context;
                const safetyDecision = await toolSafetyGuard?.beforeToolCall(effective, signal);
                return (safetyDecision ??
                    runPluginPreToolHook({
                        input,
                        pluginToolContexts,
                        context: effective,
                        signal,
                        delegated: delegatedToolCalls.get(context.toolCall.id),
                    }));
            },
            (context, signal) => {
                const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
                return toolPolicyGuard?.beforeToolCall({
                    ...(input.assemblyContext.plan ? { plan: input.assemblyContext.plan } : {}),
                    genuineUserQueryText: input.request.genuineUserQueryText,
                    toolContext: effective,
                    ...(signal ? { signal } : {}),
                });
            },
            (context) => {
                const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
                return toolsDisabled
                    ? {
                        block: true,
                        reason: `Local runtime tool execution is disabled: ${effective.toolCall.name}`,
                    }
                    : undefined;
            },
            ...(input.assembly.hooks.beforeToolCallHook ?? []).map((hook) => (context, signal) => hook(effectiveBeforeToolContext(delegatedToolCalls, context), signal)),
            async (context, signal) => {
                const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
                try {
                    const decision = await permissionGuard(effective, signal);
                    if (decision)
                        return decision;
                    const authorization = authorizeDelegatedToolCall(delegatedToolCalls.get(context.toolCall.id));
                    if (authorization)
                        return authorization;
                    if (input.control.openToolResultTail())
                        return undefined;
                    revokeDelegatedToolCallAuthorization(delegatedToolCalls.get(context.toolCall.id));
                    return { block: true, reason: 'Tool-result delivery seam is closed.' };
                }
                finally {
                    input.pluginApprovalRequests?.delete(context.toolCall.id);
                }
            },
        ],
        onToolExecutionStartHook: [
            ...(input.pluginHooks?.length
                ? [
                    ((context) => {
                        pluginToolStartedAtMs.set(context.toolCall.id, Date.now());
                    }),
                ]
                : []),
            ...(input.assembly.hooks.onToolExecutionStartHook ?? []).map((hook) => (context) => hook(effectiveToolExecutionStartContext(delegatedToolCalls, context))),
        ],
        afterToolCallHook: [
            async (context, signal) => {
                const authoritativeToolCallId = context.toolCall.id;
                const delegated = delegatedToolCalls.get(authoritativeToolCallId);
                const effectiveContext = effectiveAfterToolContext(delegated, context);
                const startedAtMs = pluginToolStartedAtMs.get(authoritativeToolCallId);
                pluginToolStartedAtMs.delete(authoritativeToolCallId);
                const toolDurationMs = startedAtMs === undefined ? undefined : Math.max(0, Date.now() - startedAtMs);
                let deliveryClosed = false;
                try {
                    await observeRawToolResultSafety(toolSafetyGuard, input.assembly.tools, effectiveContext, signal);
                    const applied = await runAfterToolHooks(input.assembly.hooks.afterToolCallHook ?? [], effectiveContext, signal ?? input.lease.signal);
                    const pluginDecision = await runPluginPostToolHook({
                        input,
                        signal,
                        context: applied.context,
                        priorContext: pluginToolContexts.get(authoritativeToolCallId),
                        durationMs: toolDurationMs,
                        delegated,
                    });
                    pluginToolContexts.delete(authoritativeToolCallId);
                    const effectiveDecision = pluginDecision
                        ? mergeAfterToolDecision(applied.decision, pluginDecision)
                        : applied.decision;
                    const finalized = await finalizeAfterToolCallForHistory({
                        input,
                        context: applied.context,
                        decision: effectiveDecision,
                        finalizer: finalizeToolResultForHistory,
                        signal: signal ?? input.lease.signal,
                    });
                    recordSuccessfulTaskOutputRead(readTaskOutputTaskIds, finalized.context, finalized.decision, options.terminalTaskOutputReadIds);
                    deliveryClosed = true;
                    const claimed = input.control.closeAndClaimToolResultTail(authoritativeToolCallId);
                    const tail = toToolResultTail(claimed);
                    if (tail.length > 0)
                        pendingToolResultTailClaims.add(authoritativeToolCallId);
                    return tail.length === 0
                        ? finalized.decision
                        : mergeAfterToolDecision(finalized.decision, {
                            content: [
                                ...(finalized.decision?.content ?? finalized.context.result.content),
                                ...tail,
                            ],
                        });
                }
                finally {
                    delegatedToolCalls.delete(authoritativeToolCallId);
                    input.pluginHostApprovalTargets?.delete(authoritativeToolCallId);
                    if (!deliveryClosed)
                        input.control.closeAndClaimToolResultTail(authoritativeToolCallId);
                }
            },
        ],
    };
}
function prepareDelegatedToolCall(input, calls, context) {
    if (context.toolCall.name !== 'mcp_invoke' || !hasHostToolReference(context.args)) {
        const binding = directBrowserHostBinding(input.assembly.tools, context.toolCall.name);
        if (binding)
            input.pluginHostApprovalTargets?.set(context.toolCall.id, binding);
        return { context };
    }
    const gateway = input.assembly.tools.find((tool) => tool.def.name === 'mcp_invoke');
    if (!gateway) {
        return {
            context,
            decision: { block: true, reason: 'Host-bound gateway is unavailable for this turn.' },
        };
    }
    const resolution = resolveDelegatedToolTarget(gateway, context.args);
    if (!resolution || resolution.kind === 'error') {
        return {
            context,
            decision: {
                block: true,
                reason: resolution?.message ?? 'Host-bound gateway could not resolve the requested tool_ref.',
            },
        };
    }
    if (resolution.selectorKind !== 'tool_ref')
        return { context };
    if (!resolution.pluginName) {
        return {
            context,
            decision: { block: true, reason: 'Host-bound tool_ref has no trusted Plugin owner.' },
        };
    }
    const delegated = {
        gateway,
        gatewayInput: recordValue(context.args),
        target: resolution,
    };
    calls.set(context.toolCall.id, delegated);
    input.pluginHostApprovalTargets?.set(context.toolCall.id, {
        tool: resolution.target,
        inputSchema: resolution.inputSchema,
        pluginName: resolution.pluginName,
    });
    return { context: effectiveBeforeToolContext(calls, context) };
}
function hasHostToolReference(value) {
    return isRecord(value) && typeof value.tool_ref === 'string' && value.tool_ref.length > 0;
}
function effectiveBeforeToolContext(calls, context) {
    const delegated = calls.get(context.toolCall.id);
    if (!delegated)
        return context;
    return {
        ...context,
        toolCall: {
            ...context.toolCall,
            name: delegated.target.target.def.name,
            arguments: delegated.target.arguments,
            ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
        },
        args: delegated.target.arguments,
    };
}
function effectiveAfterToolContext(delegated, context) {
    if (!delegated)
        return context;
    return {
        ...context,
        toolCall: {
            ...context.toolCall,
            name: delegated.target.target.def.name,
            arguments: delegated.target.arguments,
            ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
        },
        args: delegated.target.arguments,
    };
}
function effectiveToolExecutionStartContext(calls, context) {
    const delegated = calls.get(context.toolCall.id);
    if (!delegated)
        return context;
    return {
        ...context,
        toolCall: {
            ...context.toolCall,
            name: delegated.target.target.def.name,
            arguments: delegated.target.arguments,
            ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
        },
        args: delegated.target.arguments,
    };
}
function authorizeDelegatedToolCall(delegated) {
    if (!delegated)
        return undefined;
    const authorization = authorizeDelegatedToolReference(delegated.gateway, delegated.gatewayInput);
    return authorization.kind === 'error'
        ? { block: true, reason: authorization.message }
        : undefined;
}
function revokeDelegatedToolCallAuthorization(delegated) {
    if (!delegated)
        return;
    revokeDelegatedToolReferenceAuthorization(delegated.gateway, delegated.gatewayInput);
}
function delegatedValidationTool(delegated) {
    return {
        ...delegated.target.target,
        def: { ...delegated.target.target.def, schema: delegated.target.inputSchema },
    };
}
function directBrowserHostBinding(tools, toolName) {
    const tool = tools.find((candidate) => candidate.def.name === toolName);
    return tool ? getBrowserHostBinding(tool) : undefined;
}
async function observeRawToolResultSafety(guard, tools, context, signal) {
    if (!guard)
        return;
    const binding = directBrowserHostBinding(tools, context.toolCall.name);
    // Safety follows the admitted Host target; Plugin hooks and history retain the public alias.
    const trustedContext = binding
        ? {
            ...context,
            toolCall: {
                ...context.toolCall,
                name: binding.tool.def.name,
                source: binding.tool.source,
            },
        }
        : context;
    await guard.afterToolCall(trustedContext, signal);
}
async function finalizeAfterToolCallForHistory(options) {
    const { input, context, decision, finalizer, signal } = options;
    const effectiveContext = decision ? applyAfterToolDecision(context, decision) : context;
    const historyDecision = await finalizer?.({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        agentName: input.session.agentName,
        workspaceDir: input.session.workspaceDir,
        toolContext: effectiveContext,
    }, signal);
    return {
        context: effectiveContext,
        decision: historyDecision ? mergeAfterToolDecision(decision, historyDecision) : decision,
    };
}
async function runPluginPreToolHook(invocation) {
    const { input, context, signal, delegated } = invocation;
    if (!input.pluginHooks?.length)
        return undefined;
    const result = await pluginHookCoordinator.runEvent(input.pluginHooks, {
        event: 'PreToolUse',
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd: input.session.workspaceDir,
        ...input.pluginHookRuntimeContext,
        ...pluginToolProvenance(input, context.toolCall.name, delegated),
        matcherValue: context.toolCall.name,
        payload: {
            tool_name: context.toolCall.name,
            tool_input: recordValue(context.args),
            tool_use_id: context.toolCall.id,
        },
    }, signal ?? input.lease.signal);
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: 'PreToolUse',
        result,
    });
    return applyPluginPreToolDecision(invocation, result);
}
function applyPluginPreToolDecision(invocation, result) {
    const { input, pluginToolContexts, context, delegated } = invocation;
    const direct = directBrowserHostBinding(input.assembly.tools, context.toolCall.name);
    const tools = direct
        ? [
            {
                ...direct.tool,
                def: {
                    ...direct.tool.def,
                    name: context.toolCall.name,
                    schema: direct.inputSchema,
                },
            },
        ]
        : input.assembly.tools;
    const invalidRewrite = applyPluginToolRewrite(delegated ? [delegatedValidationTool(delegated)] : tools, context, result.decision.updatedInput);
    if (invalidRewrite) {
        input.pluginApprovalRequests?.delete(context.toolCall.id);
        pluginToolContexts.delete(context.toolCall.id);
        return { block: true, reason: invalidRewrite };
    }
    recordPluginApprovalRequest(input, context, result);
    const hookContext = result.decision.additionalContext?.trim();
    if (hookContext)
        pluginToolContexts.set(context.toolCall.id, hookContext);
    const blockDecision = pluginPreToolBlockDecision(result, hookContext);
    if (blockDecision)
        pluginToolContexts.delete(context.toolCall.id);
    return blockDecision;
}
function pluginPreToolBlockDecision(result, hookContext) {
    if (result.decision.continue === false) {
        return {
            block: true,
            reason: result.decision.stopReason ?? 'Agent stopped by Plugin Hook.',
            terminateAgent: true,
        };
    }
    if (isDeferredPluginToolDecision(result)) {
        return {
            block: true,
            reason: mergePluginHookContext('PreToolUse Plugin Hook requested deferred execution, which Desktop does not support.', hookContext) ?? 'PreToolUse Plugin Hook requested deferred execution.',
        };
    }
    if (result.decision.decision === 'deny') {
        return {
            block: true,
            reason: mergePluginHookContext(result.decision.reason ?? 'Tool blocked by Plugin Hook.', hookContext) ?? 'Tool blocked by Plugin Hook.',
        };
    }
    return undefined;
}
function recordPluginApprovalRequest(input, context, result) {
    const behavior = result.decision.toolPermissionDecision;
    if (behavior !== 'allow' && behavior !== 'ask')
        return;
    input.pluginApprovalRequests?.set(context.toolCall.id, {
        behavior,
        ...(result.decision.reason ? { reason: result.decision.reason } : {}),
    });
}
function isDeferredPluginToolDecision(result) {
    return (result.decision.defer === true ||
        result.decision.decision === 'defer' ||
        result.decision.toolPermissionDecision === 'defer');
}
async function runPluginPostToolHook(invocation) {
    const { input, context, signal, priorContext } = invocation;
    if (!input.pluginHooks?.length)
        return undefined;
    const failed = isFailedToolResult(context);
    const postToolHandlers = selectPostToolHandlers(input.pluginHooks);
    if (postToolHandlers.length === 0) {
        return priorPluginToolContextDecision(context, priorContext);
    }
    const pluginResult = await pluginHookCoordinator.runEvent(postToolHandlers, buildPluginPostToolEvent(invocation, failed), signal ?? input.lease.signal);
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: 'PostToolUse',
        result: pluginResult,
    });
    return buildPluginPostToolDecision(context, priorContext, pluginResult);
}
function selectPostToolHandlers(handlers) {
    return handlers.filter((handler) => handler.event === 'PostToolUse');
}
function priorPluginToolContextDecision(context, priorContext) {
    return priorContext
        ? {
            content: composePluginHookToolResultContent(context.result.content, undefined, priorContext),
        }
        : undefined;
}
function buildPluginPostToolEvent(invocation, failed) {
    const { input, context, durationMs } = invocation;
    const toolProvenance = pluginToolProvenance(input, context.toolCall.name, invocation.delegated);
    const toolResponseInput = {
        toolName: context.toolCall.name,
        args: recordValue(context.args),
        result: context.result,
        cwd: input.session.workspaceDir,
        ...toolProvenance,
    };
    const compatibleToolResponse = buildCompatiblePostToolResponse(toolResponseInput);
    const codexToolResponse = buildCodexPostToolResponse(toolResponseInput);
    return {
        event: 'PostToolUse',
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd: input.session.workspaceDir,
        ...input.pluginHookRuntimeContext,
        ...toolProvenance,
        matcherValue: context.toolCall.name,
        payload: {
            tool_name: context.toolCall.name,
            tool_input: recordValue(context.args),
            tool_use_id: context.toolCall.id,
            tool_result: context.result,
            ...(compatibleToolResponse ? { compatible_tool_response: compatibleToolResponse } : {}),
            ...(codexToolResponse !== undefined ? { codex_tool_response: codexToolResponse } : {}),
            is_error: failed,
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        },
    };
}
function buildPluginPostToolDecision(context, priorContext, pluginResult) {
    const hookContext = mergePluginHookContext(priorContext, pluginResult.decision.additionalContext);
    const content = composePluginHookToolResultContent(context.result.content, pluginResult.decision.updatedResult, hookContext, {
        sourceFormat: pluginResult.decision.updatedResultFormat,
        toolName: context.toolCall.name,
    });
    const postToolFeedback = pluginResult.decision.postToolFeedback?.trim();
    const contentWithFeedback = postToolFeedback
        ? [
            {
                type: 'text',
                text: `<plugin-hook-feedback>\n${postToolFeedback}\n</plugin-hook-feedback>`,
            },
        ]
        : content;
    return {
        ...(contentWithFeedback ? { content: contentWithFeedback } : {}),
        ...(postToolFeedback ? { isError: true } : {}),
        ...(pluginResult.decision.continue === false && !postToolFeedback
            ? { terminateAgent: true }
            : {}),
    };
}
function pluginToolProvenance(input, toolName, delegated) {
    const hostOwner = delegated?.target.pluginName ??
        directBrowserHostBinding(input.assembly.tools, toolName)?.pluginName;
    if (hostOwner) {
        return {
            toolProvenance: {
                kind: 'plugin_host',
                pluginName: hostOwner,
            },
        };
    }
    const pluginName = input.pluginMcpToolOwners?.get(toolName);
    return pluginName ? { toolProvenance: { kind: 'plugin_mcp', pluginName } } : {};
}
function isFailedToolResult(context) {
    const details = recordValue(context.result.details);
    return context.isError || details.is_error === true || details.ok === false;
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function replaceRecord(target, value) {
    if (!target || typeof target !== 'object' || Array.isArray(target))
        return;
    const mutable = target;
    for (const key of Object.keys(mutable))
        delete mutable[key];
    Object.assign(mutable, value);
}
function applyPluginToolRewrite(tools, context, updatedInput) {
    if (!updatedInput)
        return undefined;
    if (!isRuntimeToolInputValid(tools, context.toolCall.name, updatedInput)) {
        return `PreToolUse Plugin Hook returned invalid input for ${context.toolCall.name}.`;
    }
    replaceRecord(context.args, updatedInput);
    return undefined;
}
async function runAfterToolHooks(hooks, initial, signal) {
    return hooks.reduce(async (pending, hook) => {
        const current = await pending;
        const returnedPatch = await hook(current.context, signal);
        if (!returnedPatch)
            return current;
        return {
            context: applyAfterToolDecision(current.context, returnedPatch),
            decision: mergeAfterToolDecision(current.decision, returnedPatch),
        };
    }, Promise.resolve({ context: initial, decision: undefined }));
}
function mergeAfterToolDecision(base, patch) {
    return {
        ...(base ?? {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.details !== undefined ? { details: patch.details } : {}),
        ...(patch.isError !== undefined ? { isError: patch.isError } : {}),
        ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
        ...(patch.terminateAgent !== undefined ? { terminateAgent: patch.terminateAgent } : {}),
    };
}
function applyAfterToolDecision(context, patch) {
    return {
        ...context,
        result: {
            ...context.result,
            ...(patch.content !== undefined ? { content: patch.content } : {}),
            ...(patch.details !== undefined ? { details: patch.details } : {}),
            ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
        },
        isError: patch.isError ?? context.isError,
    };
}
function toToolResultTail(messages) {
    return messages.map(({ message }) => ({
        type: 'text',
        text: requireSteerContent(message.text),
    }));
}
function requireSteerContent(content) {
    if (!content) {
        throw new TypeError('AgentHost steer message content must be a non-empty string.');
    }
    return content;
}
function recordSuccessfulTaskOutputRead(taskIds, context, decision, terminalTaskIds) {
    const read = {
        toolName: context.toolCall.name,
        isError: decision?.isError ?? context.isError,
        args: context.args,
        details: decision?.details ?? context.result.details,
    };
    const taskId = successfulTaskOutputReadTaskId(read);
    if (taskId)
        taskIds.add(taskId);
    const terminalTaskId = successfulTerminalTaskOutputReadTaskId(read);
    if (terminalTaskId)
        terminalTaskIds?.add(terminalTaskId);
}
//# sourceMappingURL=plugin-hook-tool-lifecycle.js.map