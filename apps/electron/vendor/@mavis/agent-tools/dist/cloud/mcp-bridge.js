/**
 * mcp-bridge.ts — load tools from an external MCP server and wrap each one
 * as a cloud-runtime `RuntimeTool` so pi-agent's tool registry can dispatch
 * them transparently alongside the built-in `cloud-*` tools.
 *
 * Per-turn identity injection
 * ----------------------------
 * Each `tools/call` must carry the caller's archon identity headers
 * (`X-Archon-User-Id` / `X-Archon-Biz-Id` / `X-Archon-Session-Id`). Because
 * the MCP `Client` + `StreamableHTTPClientTransport` is process-shared per
 * `cfg.name` (re-connecting on every tool call would re-handshake and break
 * server-side session continuity), the headers cannot be baked into the
 * transport's `requestInit`. Instead the transport is constructed with a
 * `fetch` closure that reads headers from a mutable slot owned by the
 * bridge; each wrapper invocation sets the slot before calling `callTool`
 * and clears it in `finally`. Concurrent invocations against the same
 * server are serialised through a per-server promise queue
 * (`callLock`) so the slot is never overwritten mid-flight by a parallel
 * tool dispatch.
 *
 * Identity model
 * --------------
 * `bizId` is a free-form string ("mavis" today, never `ParseInt`-validated
 * downstream). The identity provider is invoked lazily once per `callTool`
 * so the caller can derive `sessionId` from the per-turn execution context
 * while sourcing `userId` / `bizId` from process-level state bound by the
 * first `control_harness` request (see `runtime-identity.ts`). If
 * `identityProvider` throws (identity not yet bound), the tool call rejects
 * — this should never happen in practice because turns only fire after
 * identity binding completes.
 *
 * Schema passthrough
 * ------------------
 * `def.schema` retains the raw JSON Schema from the MCP server. The same
 * schema drives model disclosure and host argument validation before dispatch.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TOOL_RESULT_RAW_ARTIFACT } from './tool-result-truncation.js';
import { withCloudCompatibleToolResponse, withCloudCodexToolResponse, } from './cloud-plugin-hook-response.js';
import { logger } from './runtime-types.js';
const CONNECTION_CACHE = new Map();
function connectMcpServer(cfg) {
    const existing = CONNECTION_CACHE.get(cfg.name);
    if (existing)
        return existing;
    const promise = (async () => {
        const identitySlot = { current: null };
        const staticHeaders = { ...(cfg.headers ?? {}) };
        const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
            fetch: (input, init) => {
                const headers = new Headers(init?.headers ?? undefined);
                for (const [k, v] of Object.entries(staticHeaders)) {
                    if (!headers.has(k))
                        headers.set(k, v);
                }
                const id = identitySlot.current;
                if (id) {
                    // Identity headers always take precedence over static cfg headers
                    // — the per-turn caller must be the authoritative identity.
                    headers.set('X-Archon-User-Id', id.userId);
                    headers.set('X-Archon-Biz-Id', id.bizId);
                    headers.set('X-Archon-Session-Id', id.sessionId);
                }
                const merged = { ...init, headers };
                return fetch(input, merged);
            },
        });
        const client = new Client({ name: `mavis-cloud-runtime-${cfg.name}`, version: '0.1.0' }, { capabilities: {} });
        await client.connect(transport);
        return { client, identitySlot, callLock: Promise.resolve() };
    })();
    CONNECTION_CACHE.set(cfg.name, promise);
    // Drop the cache entry if the initial connection failed so the next call
    // can retry instead of permanently caching the rejection.
    promise.catch(() => {
        CONNECTION_CACHE.delete(cfg.name);
    });
    return promise;
}
/**
 * Connect to `cfg.url`, enumerate the server's tools, and return one
 * `RuntimeTool` per remote tool. Names use `mcp__<server>__<tool>` to avoid
 * collisions with both built-in tools and tools from other MCP servers.
 *
 * Connection failures surface to the caller. cloud-runtime's
 * `buildCloudToolRegistry` swallows per-server load failures so a single
 * misconfigured MCP server cannot block other tools from registering.
 *
 * Generic `TCtx` lets the caller widen the context type (cloud-runtime
 * supplies `CloudRuntimeContext`) without forcing the bridge to import
 * cloud-runtime-specific types.
 */
export async function loadMcpToolsAsRuntimeTools(cfg, identityProvider) {
    const connection = await connectMcpServer(cfg);
    const listResult = await connection.client.listTools();
    const denySet = new Set(cfg.denyTools ?? []);
    const bounds = [];
    const denied = [];
    for (const remote of listResult.tools ?? []) {
        if (!remote || typeof remote.name !== 'string' || remote.name.length === 0) {
            // Skip malformed entries — MCP server bug, not bridge bug.
            continue;
        }
        // deny_tools matches against the REMOTE name (matrix_extract_content_from_websites,
        // not matrix_matrix_…), so the operator-facing yaml/env stays grep-aligned with
        // what mcp-server publishes. The local registry name is whatever the dedup logic
        // in buildRuntimeTool produces — that's an internal implementation detail callers
        // don't see.
        if (denySet.has(remote.name)) {
            denied.push(remote.name);
            continue;
        }
        bounds.push(buildRuntimeTool(cfg, connection, remote, identityProvider));
    }
    if (denied.length > 0) {
        logger.info(`mcp: dropped ${denied.length} tool(s) from '${cfg.name}' per deny_tools: ${denied.join(', ')}`);
    }
    return bounds;
}
function buildRuntimeTool(cfg, connection, remote, identityProvider) {
    // If the remote already prefixes its tool (for example `matrix_web_search`),
    // strip that duplicate server segment before building the canonical runtime
    // name so the result is `mcp__matrix__web_search`.
    const remoteName = remote.name.startsWith(`${cfg.name}_`)
        ? remote.name.slice(cfg.name.length + 1)
        : remote.name;
    const localName = buildMcpToolRuntimeName(cfg.name, remoteName);
    const def = {
        name: localName,
        description: remote.description ?? '',
        // Retain the provider schema for both disclosure and dispatch validation.
        schema: (remote.inputSchema ?? { type: 'object', properties: {} }),
    };
    const impl = {
        async execute(ctx, input, signal) {
            // FIFO queue: every callTool waits for the previous one on this server
            // to release its turn before writing to the shared identity slot.
            const myTurn = connection.callLock;
            let release = () => undefined;
            connection.callLock = new Promise((resolve) => {
                release = resolve;
            });
            await myTurn;
            try {
                connection.identitySlot.current = identityProvider(ctx);
                const result = await connection.client.callTool({ name: remote.name, arguments: input }, undefined, signal ? { signal } : undefined);
                return formatMcpToolResult(localName, result);
            }
            finally {
                connection.identitySlot.current = null;
                release();
            }
        },
    };
    return { def, impl, source: 'configured' };
}
/**
 * Flatten an MCP `tools/call` result into a cloud-runtime `ToolResult`.
 *
 * Text blocks are the only blocks copied into model-visible content. Non-text
 * blocks stay block-aware: the model receives a small placeholder, while the
 * raw MCP payload is attached through a symbol-keyed artifact channel that the
 * cloud tool-result wrapper spills to NAS before persistence.
 */
export function formatMcpToolResult(toolName, raw) {
    const result = raw ?? {};
    const blocks = Array.isArray(result.content) ? result.content : [];
    const parts = [];
    let nonTextBlocks = 0;
    for (const block of blocks) {
        if (!block || typeof block !== 'object')
            continue;
        const b = block;
        if (b.type === 'text') {
            if (typeof b.text === 'string' && b.text.length > 0) {
                parts.push(b.text);
            }
            continue;
        }
        nonTextBlocks += 1;
        const type = typeof b.type === 'string' && b.type.length > 0 ? b.type : 'unknown';
        parts.push(`[mcp] non-text block omitted from preview: type=${type}`);
    }
    let text;
    if (parts.length === 0) {
        text =
            result.isError === true
                ? '[mcp] tool returned an error with no content'
                : '[mcp] (empty result)';
    }
    else {
        text = parts.join('\n\n');
    }
    const details = {
        mcp_content_blocks: blocks.length,
        mcp_non_text_blocks: nonTextBlocks,
        ...(result.isError === true ? { mcp_is_error: true } : {}),
        ...(isRecord(result._meta) ? { mcp_meta: result._meta } : {}),
    };
    if (nonTextBlocks > 0) {
        details[TOOL_RESULT_RAW_ARTIFACT] = {
            filename: 'mcp-result.json',
            mediaType: 'application/json',
            value: raw,
        };
    }
    const toolResult = {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        isError: result.isError === true,
        details,
    };
    // Both vendor CLIs expose the original MCP CallToolResult to PostToolUse.
    // Preserve it before Cloud flattens text and spills non-text blocks.
    return isRecord(raw)
        ? withCloudCodexToolResponse(withCloudCompatibleToolResponse(toolResult, raw), raw)
        : toolResult;
}
/**
 * Test-only reset of the process-level connection cache. Production code
 * never re-imports a server during the lifetime of a cloud-runtime pod.
 */
export function __resetMcpConnectionCacheForTest() {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('__resetMcpConnectionCacheForTest can only be called when NODE_ENV=test');
    }
    CONNECTION_CACHE.clear();
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function buildMcpToolRuntimeName(serverName, toolName) {
    // 这条旧桥接链路已经不再接入 Cloud Runtime；保留原有命名结果，同时避免 agent-tools 反向依赖 MCP 模块。
    return `mcp__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 80);
}
//# sourceMappingURL=mcp-bridge.js.map