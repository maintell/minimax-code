import { AgentToolMode } from '@mavis/protocol';
import { PluginSystemCloudTransport, PluginSystemCloudTransportError } from '../cloud-transport.js';
const CONNECTOR_BASE = '/minimax-cloud/api/v1/connectors';
// Tool discovery runs before every Desktop turn. It is fail-open in the
// runtime, so keep this budget short enough that a slow Cloud dependency does
// not make message sending appear stuck.
const CONNECTOR_TOOL_LIST_TIMEOUT_MS = 5_000;
const CONNECTOR_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Existing CloudConnectorService client used directly by Desktop turns. */
export class ConnectorCloudClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    listConnectedTools(signal) {
        return this.requestConnectedTools(signal);
    }
    callTool(input) {
        return this.requestToolCall(input);
    }
    /** Explicit credential adapter reserved for the Host-process Connector boundary. */
    asHostProcessClient() {
        return {
            listConnectedTools: (input) => this.requestConnectedTools(input.signal, input.credential),
            callTool: (input) => this.requestToolCall(input, input.credential, input.onDispatch),
        };
    }
    async requestConnectedTools(signal, credential) {
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CONNECTOR_BASE}/connected-tools/list`,
            auth: 'required',
            ...(credential ? { authContext: credential } : {}),
            timeoutMs: CONNECTOR_TOOL_LIST_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
        });
        const record = requireRecord(payload, 'Connector tools response');
        return freeze({
            tools: freeze(readArray(record, 'tools', 'tools').map(readTool)),
            providerFailures: freeze(readArray(record, 'provider_failures', 'providerFailures').map(readProviderFailure)),
            partial: requireBoolean(record, 'partial', 'partial'),
        });
    }
    async requestToolCall(input, credential, onDispatch) {
        const argumentsJson = JSON.stringify(input.arguments);
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CONNECTOR_BASE}/tools/call`,
            auth: 'required',
            ...(credential ? { authContext: credential } : {}),
            timeoutMs: CONNECTOR_TOOL_CALL_TIMEOUT_MS,
            body: {
                provider: input.provider,
                provider_tool_name: input.providerToolName,
                runtime_tool_name: input.runtimeToolName,
                arguments_json: argumentsJson,
                session_id: input.sessionId,
                turn_id: input.turnId,
                tool_call_id: input.toolCallId,
                request_id: input.requestId,
                trace_id: input.traceId,
            },
            ...(onDispatch ? { onDispatch } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const record = requireRecord(payload, 'Connector tool call response');
        return freeze({
            ...optionalString(record, 'result_json', 'resultJson', 'resultJson'),
            ...optionalBoolean(record, 'is_error', 'isError', 'isError'),
            ...optionalString(record, 'error_code', 'errorCode', 'errorCode'),
            ...optionalString(record, 'error_message', 'errorMessage', 'errorMessage'),
            ...optionalNumber(record, 'latency_ms', 'latencyMs', 'latencyMs'),
            ...optionalString(record, 'provider_usage_json', 'providerUsageJson', 'providerUsageJson'),
        });
    }
}
function readTool(value) {
    const record = requireRecord(value, 'Connector tool');
    // agent_tool_mode 是 optional，也可能显式返回 null；这两种情况都交给后续逻辑按 inline 处理。
    return freeze({
        provider: requireString(record, 'provider', 'provider'),
        ...optionalString(record, 'provider_display_name', 'providerDisplayName', 'providerDisplayName'),
        ...optionalString(record, 'provider_logo_url', 'providerLogoUrl', 'providerLogoUrl'),
        providerToolName: requireString(record, 'provider_tool_name', 'providerToolName'),
        runtimeToolName: requireString(record, 'runtime_tool_name', 'runtimeToolName'),
        ...optionalString(record, 'description', 'description', 'description'),
        inputSchemaJson: requireString(record, 'input_schema_json', 'inputSchemaJson'),
        ...optionalString(record, 'output_schema_json', 'outputSchemaJson', 'outputSchemaJson'),
        ...optionalAgentToolMode(record),
    });
}
function optionalAgentToolMode(record) {
    const value = field(record, 'agent_tool_mode', 'agentToolMode');
    // optional 枚举的 null 与缺省含义相同；未知数字继续交给 runtime 按 INLINE 兼容。
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'number' || !Number.isInteger(value))
        invalid('agent_tool_mode');
    return { agentToolMode: value };
}
function readProviderFailure(value) {
    const record = requireRecord(value, 'Connector provider failure');
    return freeze({
        provider: requireString(record, 'provider', 'provider'),
        code: requireString(record, 'code', 'code'),
        message: requireString(record, 'message', 'message'),
        ...optionalBoolean(record, 'retryable', 'retryable', 'retryable'),
    });
}
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        invalid(label);
    return value;
}
function field(record, snake, camel) {
    return record[snake] ?? record[camel];
}
function readArray(record, snake, camel) {
    const value = field(record, snake, camel);
    if (!Array.isArray(value))
        invalid(snake);
    return value;
}
function requireString(record, snake, camel) {
    const value = field(record, snake, camel);
    if (typeof value !== 'string')
        invalid(snake);
    return value;
}
function requireBoolean(record, snake, camel) {
    const value = field(record, snake, camel);
    if (typeof value !== 'boolean')
        invalid(snake);
    return value;
}
function optionalString(record, snake, camel, output) {
    const value = field(record, snake, camel);
    // 可选字段的 null 与缺省含义相同，避免把服务端空值误判为非法响应。
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'string')
        invalid(snake);
    return { [output]: value };
}
function optionalBoolean(record, snake, camel, output) {
    const value = field(record, snake, camel);
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'boolean')
        invalid(snake);
    return { [output]: value };
}
function optionalNumber(record, snake, camel, output) {
    const value = field(record, snake, camel);
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'number' || !Number.isFinite(value))
        invalid(snake);
    return { [output]: value };
}
function invalid(label) {
    throw new PluginSystemCloudTransportError('RESPONSE_INVALID', `${label} is invalid`);
}
function freeze(value) {
    return Object.freeze(value);
}
//# sourceMappingURL=cloud-client.js.map