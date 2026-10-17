import { AgentToolMode } from '@mavis/protocol';
import { createMcpInvokeTool } from '../mcp-disclosure/mcp-invoke.js';
import { buildOrReuseIndex } from '../mcp-disclosure/search-index.js';
import { createToolSearchTool } from '../mcp-disclosure/tool-search.js';
import { withToolResultTruncation } from './tool-result-truncation.js';
export const CALL_CONNECTOR_TOOL_PATH = '/archon/internal/api/v1/connectors/tool/call';
export const CONNECTOR_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
export class CloudConnectorToolFactory {
    archonServer;
    constructor(archonServer) {
        this.archonServer = archonServer;
    }
    build(configs) {
        return buildCloudConnectorToolInventory(this.buildBindings(configs)).tools;
    }
    buildBindings(configs) {
        const archonServer = this.archonServer;
        if (!archonServer)
            return [];
        const bindings = [];
        for (const config of configs) {
            const schema = parseToolSchema(config.input_schema_json);
            const rawTool = {
                def: {
                    name: config.runtime_tool_name,
                    description: config.description,
                    schema,
                },
                impl: {
                    execute: async (ctx, input, signal) => {
                        const resp = await archonServer.postJson(CALL_CONNECTOR_TOOL_PATH, {
                            provider: config.provider,
                            provider_tool_name: config.provider_tool_name,
                            runtime_tool_name: config.runtime_tool_name,
                            arguments_json: JSON.stringify(input ?? {}),
                            session_id: ctx.sessionId,
                            turn_id: ctx.turnId,
                            tool_call_id: ctx.toolCallId,
                            request_id: ctx.toolCallId ?? `${ctx.sessionId}:${ctx.turnId}:${config.runtime_tool_name}`,
                            trace_id: ctx.traceId,
                        }, signal, { timeoutMs: CONNECTOR_TOOL_TIMEOUT_MS });
                        return formatConnectorToolResult(config, resp);
                    },
                },
            };
            bindings.push({
                provider: config.provider,
                // 状态与可执行工具一起保留，后面组装工具清单时再决定直接提供、忽略或进入搜索。
                agentToolMode: normalizeAgentToolMode(config.agent_tool_mode),
                tool: withToolResultTruncation(rawTool),
            });
        }
        return bindings;
    }
}
export function buildCloudConnectorToolInventory(bindings) {
    const inlineBindings = [];
    const searchableBindings = [];
    for (const binding of bindings) {
        // 缺省、null、零值和未知枚举都由 normalizeAgentToolMode 收敛为 INLINE。
        switch (normalizeAgentToolMode(binding.agentToolMode)) {
            case AgentToolMode.OMIT:
                // OMIT 不进入直接列表，也不放入搜索索引，因此本轮无法发现或调用。
                break;
            case AgentToolMode.TOOL_SEARCH:
                searchableBindings.push(binding);
                break;
            default:
                inlineBindings.push(binding);
                break;
        }
    }
    const tools = inlineBindings.map((binding) => binding.tool);
    // 没有按需搜索工具时保持原来的工具形状，不额外增加两个通用入口。
    if (searchableBindings.length === 0)
        return { tools, inlineBindings, searchableBindings };
    const searchableTools = searchableBindings.map((binding) => binding.tool);
    // TOOL_SEARCH 工具只注册到索引和调用表，不直接出现在模型收到的工具列表中。
    const entries = searchableTools.map((tool) => ({ tool, source: 'configured' }));
    const index = buildOrReuseIndex(entries, { maxSchemaTextLen: 4096 });
    const deferredRegistry = new Map(searchableTools.map((tool) => [tool.def.name, tool]));
    const toolSearch = createToolSearchTool(index, { topKDefault: 5, topKMax: 20 });
    const mcpInvoke = createMcpInvokeTool(deferredRegistry);
    tools.push(toolSearch, mcpInvoke);
    return {
        tools,
        inlineBindings,
        searchableBindings,
        searchableAccessTools: [toolSearch, mcpInvoke],
    };
}
function normalizeAgentToolMode(mode) {
    // 只有两个显式状态会改变旧行为，其余输入全部回退到 INLINE。
    if (mode === AgentToolMode.OMIT || mode === AgentToolMode.TOOL_SEARCH)
        return mode;
    return AgentToolMode.INLINE;
}
function parseToolSchema(inputSchemaJSON) {
    try {
        const parsed = JSON.parse(inputSchemaJSON);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    }
    catch {
        // Fall through to a safe object schema. archon-server validates provider
        // catalog data; cloud-runtime keeps running even if one schema is malformed.
    }
    return { type: 'object', properties: {} };
}
function formatConnectorToolResult(config, resp) {
    const isError = resp.is_error === true;
    const errorMessage = typeof resp.error_message === 'string' ? resp.error_message : '';
    const resultText = typeof resp.result_json === 'string' && resp.result_json.length > 0
        ? resp.result_json
        : JSON.stringify(resp);
    const text = isError && errorMessage ? errorMessage : resultText;
    return {
        tool_name: config.runtime_tool_name,
        text,
        content: [{ type: 'text', text }],
        isError,
        details: {
            is_error: isError,
            error_code: resp.error_code,
            error_message: resp.error_message,
            latency_ms: resp.latency_ms,
            provider_usage_json: resp.provider_usage_json,
            app: {
                provider: config.provider,
                display_name: config.provider,
                tool: config.provider_tool_name,
            },
        },
    };
}
//# sourceMappingURL=cloud-connector.js.map