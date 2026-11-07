import { authorizeMcpInvokeReference, getMcpInvokeRegistries, resolveMcpInvokeTarget, revokeMcpInvokeReferenceAuthorization, } from '../mcp-disclosure/mcp-invoke.js';
/** The same allowed targets drive execution and Hook input validation. */
export function cloudToolHookTargets(tools) {
    const invoke = tools.find((tool) => tool.def.name === 'mcp_invoke');
    const registry = invoke ? getMcpInvokeRegistries(invoke)?.registry : undefined;
    return [...tools, ...(registry?.values() ?? [])];
}
/** Prepare once, run the existing Hook chain against that target, then admit its snapshot. */
export function withCloudToolTargetHooks(tools, hooks) {
    const invoke = tools.find((tool) => tool.def.name === 'mcp_invoke');
    if (!invoke)
        return hooks;
    const admitted = new Map();
    const beforeToolCall = async (context, signal) => {
        if (context.toolCall.name !== 'mcp_invoke')
            return runBeforeHooks(hooks, context, signal);
        revokeMcpInvokeReferenceAuthorization(invoke, context.args);
        const resolution = resolveMcpInvokeTarget(invoke, context.args);
        if (!resolution)
            return { block: true, reason: 'On-demand tool gateway has no registered targets.' };
        if (resolution.kind === 'error')
            return { block: true, reason: resolution.message };
        if (resolution.selectorKind !== 'tool_name') {
            revokeMcpInvokeReferenceAuthorization(invoke, context.args);
            return { block: true, reason: 'Cloud tool calls require a named tool target.' };
        }
        const targetContext = projectTarget(context, resolution);
        // Preserve the prepared argument object across every Hook and the final admission.
        context.args.arguments = resolution.arguments;
        try {
            const decision = await runBeforeHooks(hooks, targetContext, signal);
            if (decision?.block) {
                revokeMcpInvokeReferenceAuthorization(invoke, context.args);
                return decision;
            }
            if (signal?.aborted)
                throw signal.reason;
            const admission = authorizeMcpInvokeReference(invoke, context.args);
            if (admission.kind === 'error') {
                revokeMcpInvokeReferenceAuthorization(invoke, context.args);
                return { block: true, reason: admission.message };
            }
            // PostToolUse observes the admitted arguments even when an implementation
            // mutates its private execution input. It never prepares arguments again.
            admitted.set(context.toolCall.id, {
                ...admission,
                arguments: structuredClone(admission.arguments),
            });
            return decision;
        }
        catch (error) {
            revokeMcpInvokeReferenceAuthorization(invoke, context.args);
            admitted.delete(context.toolCall.id);
            throw error;
        }
    };
    const afterHooks = hooks.afterToolCallHook?.length ? hooks.afterToolCallHook : [undefined];
    return {
        ...hooks,
        beforeToolCallHook: [beforeToolCall],
        afterToolCallHook: afterHooks.map((hook, index) => async (context, signal) => {
            if (context.toolCall.name !== 'mcp_invoke')
                return hook?.(context, signal);
            const target = admitted.get(context.toolCall.id);
            if (!target)
                return undefined;
            try {
                return await hook?.(projectTarget(context, target), signal);
            }
            catch (error) {
                admitted.delete(context.toolCall.id);
                throw error;
            }
            finally {
                if (index === afterHooks.length - 1)
                    admitted.delete(context.toolCall.id);
            }
        }),
    };
}
async function runBeforeHooks(hooks, context, signal) {
    for (const hook of hooks.beforeToolCallHook ?? []) {
        const result = await hook(context, signal);
        if (result?.block)
            return result;
    }
    return undefined;
}
function projectTarget(context, target) {
    return {
        ...context,
        toolCall: {
            ...context.toolCall,
            name: target.target.def.name,
            arguments: target.arguments,
            source: target.target.source,
        },
        args: target.arguments,
    };
}
//# sourceMappingURL=cloud-tool-target-hooks.js.map