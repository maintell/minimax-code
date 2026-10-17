import { delimiter } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { DesktopMatrixClient, } from './matrix-client.js';
import { getDesktopMatrixEndpoint } from './matrix-env.js';
import { DesktopMatrixMediaClient } from './matrix-media-client.js';
import { buildDesktopMatrixRuntimeTools } from './matrix-tools.js';
import { managedBackendRoutingHeaders } from './managed-routing.js';
export function createMatrixMcpRuntime(options) {
    const executor = options.executor ??
        new DesktopMatrixClient({
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.accessToken ? { accessToken: options.accessToken } : {}),
            ...(options.authContext ? { authContext: options.authContext } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.routingHeadersGetter
                ? { routingHeadersGetter: options.routingHeadersGetter }
                : {}),
        });
    const mediaClient = options.mediaClient ??
        new DesktopMatrixMediaClient(executor instanceof DesktopMatrixClient
            ? executor
            : new DesktopMatrixClient({
                ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
                ...(options.accessToken ? { accessToken: options.accessToken } : {}),
                ...(options.authContext ? { authContext: options.authContext } : {}),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                ...(options.routingHeadersGetter
                    ? { routingHeadersGetter: options.routingHeadersGetter }
                    : {}),
            }));
    const tools = buildDesktopMatrixRuntimeTools({
        workspaceRoot: options.workspaceRoot,
        ...(options.extraInputRoots?.length ? { extraInputRoots: options.extraInputRoots } : {}),
        executor,
        mediaClient,
    });
    return {
        tools,
        workspaceRoot: options.workspaceRoot,
        createContext: options.createContext ??
            (() => ({
                sessionId: 'matrix-mcp-stdio',
                turnId: `matrix-mcp-${Date.now()}`,
                workspaceRoot: options.workspaceRoot,
            })),
    };
}
export function createMatrixMcpRuntimeFromEnv(env = process.env, options = {}) {
    const workspaceRoot = env.MAVIS_MATRIX_WORKSPACE_ROOT || env.WORKSPACE_ROOT || process.cwd();
    // path.delimiter-joined extra input roots (fail-closed: absent env keeps the
    // fence workspace-only).
    const extraInputRoots = (env.MAVIS_MATRIX_EXTRA_INPUT_ROOTS ?? '')
        .split(delimiter)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    const endpoint = getDesktopMatrixEndpoint(env);
    const managedAccessToken = endpoint.managed && (env.MAVIS_MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN);
    return createMatrixMcpRuntime({
        workspaceRoot,
        ...(extraInputRoots.length > 0 ? { extraInputRoots } : {}),
        baseUrl: endpoint.baseUrl,
        ...(endpoint.explicitToken ? { accessToken: endpoint.explicitToken } : {}),
        ...(managedAccessToken ? { authContext: { accessToken: managedAccessToken } } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        routingHeadersGetter: () => managedBackendRoutingHeaders({ bedrockLane: env.MAVIS_MATRIX_BEDROCK_LANE }, env.MAVIS_BUILD_ENV),
    });
}
export function buildMatrixMcpToolDescriptors(runtime) {
    return runtime.tools.map((tool) => ({
        name: tool.def.name,
        description: tool.def.description,
        inputSchema: isRecord(tool.def.schema) ? tool.def.schema : { type: 'object' },
    }));
}
export async function executeMatrixMcpTool(runtime, toolName, args = {}, signal) {
    const tool = runtime.tools.find((candidate) => candidate.def.name === toolName);
    if (!tool) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Unknown Matrix MCP tool: ${toolName}` }],
            _meta: { matrix: { server: 'matrix', tool: toolName } },
        };
    }
    try {
        const prepared = tool.def.prepareArguments ? tool.def.prepareArguments(args) : args;
        const result = await tool.impl.execute(runtime.createContext(), prepared, signal);
        return formatToolResultAsMcp(toolName, result);
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Matrix MCP tool failed: ${toErrorMessage(err)}` }],
            _meta: { matrix: { server: 'matrix', tool: toolName } },
        };
    }
}
export function createMatrixMcpServer(runtime) {
    const server = new Server({ name: 'mavis-matrix-mcp-server', version: '0.2.1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: buildMatrixMcpToolDescriptors(runtime),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = isRecord(request.params.arguments) ? request.params.arguments : {};
        return executeMatrixMcpTool(runtime, name, args);
    });
    return server;
}
export async function runMatrixMcpStdioServer(runtime = createMatrixMcpRuntimeFromEnv()) {
    const server = createMatrixMcpServer(runtime);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[mavis-matrix-mcp-server] ready\n');
}
function formatToolResultAsMcp(toolName, result) {
    const content = result.content.flatMap((block) => toMcpContentBlock(block));
    if (content.length === 0 && result.text) {
        content.push({ type: 'text', text: result.text });
    }
    return {
        content,
        isError: result.isError === true,
        _meta: {
            matrix: { server: 'matrix', tool: toolName },
            ...(result.details ? { details: result.details } : {}),
            ...(result.output ? { output: result.output } : {}),
        },
    };
}
function toMcpContentBlock(block) {
    if (block.type === 'text') {
        return [{ type: 'text', text: block.text }];
    }
    if (block.type === 'image') {
        return [{ type: 'image', data: block.data, mimeType: block.mimeType }];
    }
    return [{ type: 'text', text: `[matrix] non-text block omitted from MCP preview: type=video` }];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function toErrorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=matrix-mcp-server.js.map