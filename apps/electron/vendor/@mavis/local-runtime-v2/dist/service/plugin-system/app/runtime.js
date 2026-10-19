import { AgentToolMode } from '@mavis/protocol';
import { ConnectorCloudClient, } from './cloud-client.js';
export const EMPTY_CONNECTOR_RUNTIME = {
    resolveForTurn: async () => freeze([]),
    resolveBindingsForTurn: async () => freeze([]),
};
/** Resolves a fresh Connector inventory for each callable Desktop turn. */
export class DesktopConnectorRuntime {
    options;
    logger;
    metrics;
    resolveFailure;
    authGeneration = 0;
    resolveRequestSequence = 0;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? NOOP_LOGGER;
        this.metrics = options.metrics;
    }
    async resolveForTurn(signal) {
        return freeze((await this.resolveBindingsForTurn(signal)).map((binding) => binding.tool));
    }
    /** Authentication rotation must never inherit a previous token's failure cooldown. */
    authContextChanged() {
        this.authGeneration += 1;
        this.resolveFailure = undefined;
    }
    async resolveBindingsForTurn(signal) {
        const scopeKey = this.options.scopeKeyGetter?.() ?? DEFAULT_CONNECTOR_SCOPE_KEY;
        const authGeneration = this.authGeneration;
        if (this.isResolveCircuitOpen(scopeKey)) {
            this.metrics?.incr('desktop_connector_resolve_total', { status: 'circuit_open' });
            return freeze([]);
        }
        const requestId = ++this.resolveRequestSequence;
        const result = await this.requestConnectedTools(scopeKey, authGeneration, requestId, signal);
        if (!result)
            return freeze([]);
        this.metrics?.incr('desktop_connector_resolve_total', {
            status: result.partial ? 'partial' : 'ok',
        });
        for (const failure of result.providerFailures) {
            this.metrics?.incr('desktop_connector_provider_failure_total', {
                provider: failure.provider,
                code: failure.code,
            });
            this.logger.warn('Desktop Connector provider resolve failed', {
                provider: failure.provider,
                code: failure.code,
                retryable: failure.retryable,
            });
        }
        const names = new Set();
        const bindings = [];
        for (const descriptor of result.tools) {
            const key = collisionKey(descriptor.runtimeToolName);
            // 同一轮只保留第一个同名工具，避免后返回的 provider 静默覆盖前一个工具。
            if (!key || names.has(key)) {
                this.metrics?.incr('desktop_connector_tool_skipped_total', { reason: 'name_conflict' });
                continue;
            }
            names.add(key);
            bindings.push(freeze({
                kind: 'app',
                source: descriptor.provider,
                // RuntimeTool 是所有工具共用的结构，Connector 专属状态随 binding 一起传到最终组装阶段。
                toolMode: normalizeToolMode(descriptor.agentToolMode),
                tool: this.runtimeTool(descriptor),
            }));
        }
        return freeze(bindings);
    }
    nowMs() {
        return this.options.nowMs?.() ?? Date.now();
    }
    async requestConnectedTools(scopeKey, authGeneration, requestId, signal) {
        try {
            // Connector 授权状态可能随时变化，因此每个可执行 turn 都重新获取当前用户的工具清单。
            const result = await this.options.client.listConnectedTools(signal);
            if (!this.isAuthRequestCurrent(scopeKey, authGeneration))
                return undefined;
            if (requestId === this.resolveRequestSequence)
                this.resolveFailure = undefined;
            return result;
        }
        catch (error) {
            if (!this.isAuthRequestCurrent(scopeKey, authGeneration))
                return undefined;
            if (errorCode(error) === 'AUTH_REQUIRED') {
                this.metrics?.incr('desktop_connector_resolve_total', { status: 'unauthenticated' });
                if (requestId === this.resolveRequestSequence)
                    this.resolveFailure = undefined;
                return undefined;
            }
            if (requestId === this.resolveRequestSequence)
                this.recordResolveFailure(scopeKey, error);
            this.metrics?.incr('desktop_connector_resolve_total', { status: 'error' });
            this.logger.warn('Desktop Connector tools resolve failed', { errorType: errorType(error) });
            return undefined;
        }
    }
    isResolveCircuitOpen(scopeKey) {
        if (this.resolveFailure?.scopeKey !== scopeKey)
            this.resolveFailure = undefined;
        return this.resolveFailure !== undefined && this.nowMs() < this.resolveFailure.retryAtMs;
    }
    recordResolveFailure(scopeKey, error) {
        this.resolveFailure = shouldBackoff(error)
            ? nextResolveFailure(scopeKey, this.resolveFailure, this.nowMs())
            : undefined;
    }
    isAuthRequestCurrent(scopeKey, authGeneration) {
        const currentScopeKey = this.options.scopeKeyGetter?.() ?? DEFAULT_CONNECTOR_SCOPE_KEY;
        return authGeneration === this.authGeneration && scopeKey === currentScopeKey;
    }
    runtimeTool(descriptor) {
        const name = descriptor.runtimeToolName;
        return freeze({
            def: freeze({
                name,
                description: descriptor.description ??
                    `Call ${descriptor.providerToolName} from Connector ${descriptor.provider}.`,
                schema: parseToolSchema(descriptor.inputSchemaJson),
            }),
            impl: freeze({
                execute: async (context, input, signal) => {
                    let result;
                    try {
                        result = await this.options.client.callTool({
                            provider: descriptor.provider,
                            providerToolName: descriptor.providerToolName,
                            runtimeToolName: name,
                            arguments: toRecord(input),
                            sessionId: context.sessionId,
                            turnId: context.turnId,
                            toolCallId: context.toolCallId,
                            requestId: context.toolCallId ?? `${context.sessionId}:${context.turnId}:${name}`,
                            ...(signal ? { signal } : {}),
                        });
                    }
                    catch (error) {
                        this.metrics?.incr('desktop_connector_call_total', { status: 'error' });
                        throw error;
                    }
                    const status = result.isError === true ? 'provider_error' : 'ok';
                    this.metrics?.incr('desktop_connector_call_total', { status });
                    if (result.latencyMs !== undefined) {
                        this.metrics?.latency('desktop_connector_call_latency_ms', result.latencyMs, {
                            status,
                        });
                    }
                    return formatToolResult(descriptor, result);
                },
            }),
            source: 'configured',
        });
    }
}
function normalizeToolMode(value) {
    // 只识别需要改变旧行为的两个值；空值、缺省值和未来未知值都保持 inline。
    if (value === AgentToolMode.OMIT)
        return 'omit';
    if (value === AgentToolMode.TOOL_SEARCH)
        return 'tool_search';
    return 'inline';
}
function parseToolSchema(value) {
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return freeze({
                ...parsed,
            });
        }
    }
    catch {
        // The BFF validates catalog data; a malformed entry must not break the turn.
    }
    const fallback = { type: 'object', properties: {} };
    return freeze({ ...fallback });
}
function formatToolResult(descriptor, result) {
    const isError = result.isError === true;
    const text = isError && result.errorMessage
        ? result.errorMessage
        : (result.resultJson ?? (isError ? 'Connector tool returned an error.' : ''));
    return {
        tool_name: descriptor.runtimeToolName,
        text,
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
        details: {
            is_error: isError,
            error_code: result.errorCode,
            error_message: result.errorMessage,
            latency_ms: result.latencyMs,
            provider_usage_json: result.providerUsageJson,
            app: {
                provider: descriptor.provider,
                display_name: descriptor.providerDisplayName ?? descriptor.provider,
                ...(descriptor.providerLogoUrl ? { icon_url: descriptor.providerLogoUrl } : {}),
                tool: descriptor.providerToolName,
            },
        },
    };
}
function toRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function collisionKey(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function errorType(error) {
    return error instanceof Error ? error.name : typeof error;
}
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
}
function errorStatus(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const status = Reflect.get(error, 'status');
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}
function shouldBackoff(error) {
    const code = errorCode(error);
    if (code === 'NETWORK_ERROR' || code === 'REQUEST_TIMEOUT')
        return true;
    if (code !== 'HTTP_ERROR')
        return false;
    const status = errorStatus(error);
    return status === 429 || (status !== undefined && status >= 500);
}
function nextResolveFailure(scopeKey, prior, nowMs) {
    const failureCount = prior?.scopeKey === scopeKey ? prior.failureCount + 1 : 1;
    const retryDelayMs = Math.min(10_000 * 2 ** (failureCount - 1), 30_000);
    return { scopeKey, failureCount, retryAtMs: nowMs + retryDelayMs };
}
function freeze(value) {
    return Object.freeze(value);
}
const NOOP_LOGGER = { warn: () => undefined };
const DEFAULT_CONNECTOR_SCOPE_KEY = 'default';
//# sourceMappingURL=runtime.js.map