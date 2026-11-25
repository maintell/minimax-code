import { getMcpInvokeRegistries, readToolSearchTurnFacts } from '@mavis/agent-tools/mcp-disclosure';
/**
 * Tool Search `directCall` on a non-PTC Turn: a deferred tool called by its real
 * name runs like a listed tool (same validation, hooks, permission source and
 * events) while the tools sent to the model stay unchanged. `mcp_invoke` keeps
 * routing the same targets.
 *
 * A tool that stands for a mavis command is called by its own name here, so the
 * permission gate, the Plugin hooks, history and the display see that tool with
 * its own arguments, exactly as they do on every other route.
 */
export function deferredToolDirectCallWiring(tools) {
    if (!readToolSearchTurnFacts(tools)?.directCall)
        return undefined;
    const gateway = tools?.find((tool) => tool.def.name === 'mcp_invoke');
    const registry = gateway ? getMcpInvokeRegistries(gateway)?.registry : undefined;
    if (!registry || registry.size === 0)
        return undefined;
    return {
        resolveMissingTool: (toolCall) => registry.get(toolCall.name),
        deferredTools: [...registry.values()],
    };
}
/**
 * Both wirings answer a name this Turn's catalog omits, and a non-PTC
 * directCall Turn has both. The legacy `mavis` refusal answers first so a
 * direct `mavis` call still gets the moved message; the deferred registry
 * answers everything it leaves alone. Spreading the two objects would drop
 * one of them.
 */
export function chainedResolveMissingTool(first, second) {
    return (toolCall) => first?.(toolCall) ?? second?.(toolCall);
}
//# sourceMappingURL=deferred-tool-direct-call-policy.js.map