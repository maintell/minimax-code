const CONFIGURED_GENERATION = 'configured';
/**
 * `mcp.call` targets over the two owners of MCP connections: the Plugin MCP pool (leased per
 * snapshot generation) and the user-configured MCP runtime. Each owner stamps the dispatch
 * outcome; this adapter only maps it.
 */
export function createMcpTargetCatalog(deps) {
    const pluginTargets = new Map();
    const configuredTools = new Map();
    return {
        async list(sessionId) {
            const listed = deps.plugin.list(sessionId).filter((target) => target.runtimeServerName);
            for (const target of listed)
                pluginTargets.set(pluginKey(target), target);
            const configured = await deps.configured.list();
            configuredTools.clear();
            for (const tool of configured.tools) {
                const tools = configuredTools.get(tool.server) ?? new Map();
                tools.set(tool.tool, tool.name);
                configuredTools.set(tool.server, tools);
            }
            return [
                ...listed.map((target) => toTarget(target)),
                ...[...configuredTools.keys()].map((server) => ({
                    owner: { kind: 'configured' },
                    server,
                    assignedName: server,
                    generation: CONFIGURED_GENERATION,
                })),
            ];
        },
        describeTool(target, tool) {
            if (target.owner.kind === 'configured') {
                const runtimeName = configuredTools.get(target.server)?.get(tool);
                return runtimeName ? { runtimeName } : undefined;
            }
            const runtimeName = pluginTargets.get(targetKey(target))?.tools.get(tool)?.runtimeName;
            return runtimeName ? { runtimeName } : undefined;
        },
        retain(target) {
            if (target.owner.kind === 'plugin')
                deps.plugin.retain(revisionOf(target));
        },
        release(target) {
            if (target.owner.kind === 'plugin')
                deps.plugin.release(revisionOf(target));
        },
        async dispatch(request) {
            const { target } = request;
            if (target.owner.kind === 'plugin') {
                const owned = pluginTargets.get(targetKey(target));
                if (!owned)
                    return { status: 'not_dispatched', message: 'MCP server is not published' };
                const dispatched = await deps.plugin.call({
                    target: owned,
                    tool: request.tool,
                    args: request.args,
                    ...(request.signal ? { signal: request.signal } : {}),
                });
                return dispatched.status === 'returned'
                    ? { status: 'returned', result: toMcpResult(dispatched.result) }
                    : { status: dispatched.status, message: dispatched.message };
            }
            const runtimeName = configuredTools.get(target.server)?.get(request.tool);
            if (!runtimeName)
                return { status: 'not_dispatched', message: 'MCP tool is not listed' };
            const outcome = await deps.configured.call({
                pluginId: request.caller,
                name: runtimeName,
                arguments: request.args,
                signal: request.signal ?? new AbortController().signal,
            });
            if (!outcome.ok)
                return { status: outcome.disposition, message: outcome.code };
            return {
                status: 'returned',
                result: toMcpResult({ content: outcome.content, isError: outcome.isError }),
            };
        },
    };
}
function toTarget(target) {
    return {
        owner: { kind: 'plugin', activation: target.activation },
        server: target.server,
        assignedName: target.runtimeServerName ?? target.server,
        generation: target.revision,
    };
}
function pluginKey(target) {
    return JSON.stringify([target.revision, target.source, target.pluginName, target.server]);
}
function targetKey(target) {
    if (target.owner.kind !== 'plugin')
        return '';
    return JSON.stringify([
        target.generation,
        target.owner.activation.source,
        target.owner.activation.pluginId,
        target.server,
    ]);
}
function revisionOf(target) {
    return target.generation;
}
/**
 * MCP content crosses back to the Worker as JSON; anything else is dropped to its type. Phase 1
 * also drops `structuredContent`: the SDK `McpResult` carries `content` and `isError` only.
 */
function toMcpResult(result) {
    const content = result.content.map((item) => {
        try {
            const value = JSON.parse(JSON.stringify(item));
            if (value && typeof value === 'object' && typeof value.type === 'string') {
                return value;
            }
        }
        catch {
            // Not serializable; fall through.
        }
        return { type: 'unknown' };
    });
    return { content, ...(result.isError === true ? { isError: true } : {}) };
}
//# sourceMappingURL=targets.adapter.js.map