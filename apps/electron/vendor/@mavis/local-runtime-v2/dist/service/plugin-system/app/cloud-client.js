import { readConnectedToolsResponse, readToolCallResponse, } from './cloud-client-response.js';
const CONNECTOR_BASE = '/minimax-cloud/api/v1/connectors';
// Host-process callers list tools before an interactive Mini App action, so
// keep discovery short enough that a slow Cloud dependency fails visibly.
const CONNECTOR_TOOL_LIST_TIMEOUT_MS = 5_000;
const CONNECTOR_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Existing CloudConnectorService client used by the Host-process Connector Gateway. */
export class ConnectorCloudClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    /** Explicit credential adapter reserved for the Host-process Connector boundary. */
    asHostProcessClient() {
        return {
            listConnectedTools: (input) => this.requestConnectedTools(input.credential, input.signal),
            callTool: (input) => this.requestToolCall(input, input.credential, input.onDispatch),
        };
    }
    async requestConnectedTools(credential, signal) {
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CONNECTOR_BASE}/connected-tools/list`,
            auth: 'required',
            authContext: credential,
            timeoutMs: CONNECTOR_TOOL_LIST_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
        });
        return readConnectedToolsResponse(payload);
    }
    async requestToolCall(input, credential, onDispatch) {
        const argumentsJson = JSON.stringify(input.arguments);
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CONNECTOR_BASE}/tools/call`,
            auth: 'required',
            authContext: credential,
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
        return readToolCallResponse(payload);
    }
}
//# sourceMappingURL=cloud-client.js.map