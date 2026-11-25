import { McpToolCallNotDispatchedError, McpToolCallTimeoutError, } from '@mavis/mcp';
import { pluginMcpActivationOf } from '../plugin/runtime/snapshot-builder.js';
const LISTED_VIEW_LIMIT = 32;
/**
 * The listed snapshot is remembered while any call leases it, so a call runs the runtime tool of
 * the generation it was resolved and authorized in even after a newer snapshot publishes.
 */
export function createPluginMcpCallSource(host) {
    const leased = new Map();
    // Session views are composed on demand; the latest listed ones stay resolvable for `retain`.
    const listed = new Map();
    const viewOf = (revision) => {
        const current = host.currentSnapshot.turnCapabilities;
        if (current.revision === revision)
            return current;
        return leased.get(revision)?.view ?? listed.get(revision);
    };
    return {
        list(sessionId) {
            const snapshot = sessionId && host.sessionSnapshot ? host.sessionSnapshot(sessionId) : host.currentSnapshot;
            if (snapshot !== host.currentSnapshot) {
                listed.delete(snapshot.revision);
                listed.set(snapshot.revision, snapshot.turnCapabilities);
                while (listed.size > LISTED_VIEW_LIMIT)
                    listed.delete(listed.keys().next().value ?? '');
            }
            const bindings = snapshot.turnCapabilities.runtimeToolBindings;
            return snapshot.mcpServers.map((entry) => {
                const tools = new Map();
                for (const binding of bindings) {
                    if (ownsBinding(binding, entry.pluginName, entry.server.name)) {
                        tools.set(binding.mcpToolName ?? '', listedTool(binding));
                    }
                }
                return {
                    pluginName: entry.pluginName,
                    source: entry.source,
                    activation: pluginMcpActivationOf(entry),
                    server: entry.server.name,
                    ...(entry.runtimeServerName ? { runtimeServerName: entry.runtimeServerName } : {}),
                    revision: snapshot.revision,
                    tools,
                };
            });
        },
        retain(revision) {
            const view = viewOf(revision);
            if (!view)
                throw new Error(`Plugin MCP generation ${revision} is unavailable`);
            host.retainTurnCapabilities(view);
            const held = leased.get(revision);
            if (held)
                held.count += 1;
            else
                leased.set(revision, { view, count: 1 });
        },
        release(revision) {
            const held = leased.get(revision);
            if (!held)
                return;
            host.releaseTurnCapabilities(held.view);
            held.count -= 1;
            if (held.count <= 0)
                leased.delete(revision);
        },
        async call({ target, tool, args, signal, invocation }) {
            const view = leased.get(target.revision)?.view;
            const binding = view?.runtimeToolBindings.find((candidate) => ownsBinding(candidate, target.pluginName, target.server) &&
                candidate.mcpToolName === tool);
            if (!binding) {
                return {
                    status: 'not_dispatched',
                    reason: 'not_published',
                    message: `MCP tool "${tool}" is not published`,
                };
            }
            if (signal?.aborted) {
                return {
                    status: 'not_dispatched',
                    reason: 'cancelled',
                    message: 'aborted before dispatch',
                };
            }
            try {
                const result = await binding.tool.impl.execute(invocation ?? {
                    sessionId: `plugin-extension:${target.pluginName}`,
                    turnId: 'plugin-extension-call',
                }, { ...args }, signal);
                const mcp = result.details?.mcp;
                if (!mcp || !Array.isArray(mcp.content)) {
                    return {
                        status: 'unknown_after_dispatch',
                        reason: 'unknown',
                        message: 'MCP result is unreadable',
                    };
                }
                return { status: 'returned', result: mcp };
            }
            catch (error) {
                // The pool's only error that proves nothing reached the server.
                if (error instanceof McpToolCallNotDispatchedError) {
                    return {
                        status: 'not_dispatched',
                        reason: 'cancelled',
                        message: 'the MCP call was not sent',
                    };
                }
                return error instanceof McpToolCallTimeoutError
                    ? {
                        status: 'unknown_after_dispatch',
                        reason: 'timeout',
                        message: 'the MCP call timed out after dispatch',
                    }
                    : {
                        status: 'unknown_after_dispatch',
                        reason: 'unknown',
                        message: 'the MCP call failed after dispatch',
                    };
            }
        },
    };
}
function ownsBinding(binding, pluginName, server) {
    return (binding.kind === 'mcp' &&
        binding.pluginName === pluginName &&
        binding.source === server &&
        typeof binding.mcpToolName === 'string');
}
function listedTool(binding) {
    const { def } = binding.tool;
    return {
        runtimeName: def.name,
        ...(def.description ? { description: def.description } : {}),
        inputSchema: { ...def.schema },
    };
}
//# sourceMappingURL=plugin-mcp-call-source.js.map