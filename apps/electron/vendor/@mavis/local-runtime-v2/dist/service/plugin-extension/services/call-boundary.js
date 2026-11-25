import { logger } from '../../../infra/logging/logger.js';
import { ExtensionServiceError } from '../errors.js';
/** Refusals by policy, as opposed to failures while doing the work. */
const REJECTION_CODES = new Set([
    'INVOCATION_SETTLED',
    'INVOCATION_UNKNOWN',
    'ACTIVATION_RETIRED',
    'STATE_WRITE_IN_RENDER',
    'PERMISSION_DENIED',
    'PERMISSION_REQUIRED',
    'CANCELLED',
    'MCP_CALL_RATE_LIMITED',
    'GESTURE_QUEUE_FULL',
    'AGENT_CONCURRENCY_LIMIT',
]);
/**
 * Entry of every cross-thread `ctx` call: identity comes from the host's Invocation table keyed
 * by the host-issued call id, and every attempt (including refused ones) leaves one audit row.
 */
export class CallBoundary {
    invocations;
    audit;
    constructor(invocations, audit) {
        this.invocations = invocations;
        this.audit = audit;
    }
    resolve(callId) {
        const found = this.invocations.lookup(callId);
        if (found.status === 'active')
            return found.invocation;
        throw new ExtensionServiceError('INVOCATION_UNKNOWN', 'unknown call id');
    }
    async run(call, body) {
        const startedAt = Date.now();
        const detail = {};
        let invocation;
        try {
            invocation = this.resolve(call.callId);
            const result = await body(invocation, detail);
            this.write({ call, invocation, detail, startedAt });
            return result;
        }
        catch (error) {
            this.write({ call, invocation, detail, startedAt, error });
            throw error;
        }
    }
    runSync(call, body) {
        const startedAt = Date.now();
        let invocation;
        try {
            invocation = this.resolve(call.callId);
            const result = body(invocation);
            this.write({ call, invocation, detail: {}, startedAt });
            return result;
        }
        catch (error) {
            this.write({ call, invocation, detail: {}, startedAt, error });
            throw error;
        }
    }
    write(input) {
        const { call, invocation, detail, error } = input;
        const stampedAt = Date.now();
        const code = auditCode(error);
        const origin = invocation?.origin;
        this.audit.record({
            origin: origin
                ? {
                    pluginId: origin.pluginId,
                    source: origin.source,
                    artifactDigest: origin.artifactDigest,
                    sessionId: origin.sessionId,
                    slot: origin.slot,
                    key: origin.key,
                }
                : null,
            callId: call.callId,
            domain: call.domain,
            method: call.method,
            ...auditDetailFields(detail),
            outcome: {
                status: auditStatus(detail, error, code),
                ...(code ? { code } : {}),
                ...(detail.dispatch ? { dispatch: detail.dispatch } : {}),
                stampedAt,
            },
            durationMs: stampedAt - input.startedAt,
        });
    }
}
function auditDetailFields(detail) {
    return {
        ...(detail.agent ? { agent: detail.agent } : {}),
        ...(detail.model ? { model: detail.model } : {}),
        ...(detail.usage ? { usage: detail.usage } : {}),
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.errorKind ? { errorKind: detail.errorKind } : {}),
        ...(detail.mcp ? { mcp: detail.mcp } : {}),
        ...(detail.mcpResult ? { mcpResult: detail.mcpResult } : {}),
    };
}
function auditCode(error) {
    if (error === undefined)
        return undefined;
    return error instanceof ExtensionServiceError ? error.code : 'INTERNAL';
}
function auditStatus(detail, error, code) {
    if (error === undefined)
        return detail.status ?? 'ok';
    return REJECTION_CODES.has(code) ? 'rejected' : 'error';
}
/**
 * Structured log row, the same grade as the Host Connector audit. MCP result content stays out
 * of the log (it can carry user data); only its shape is kept.
 */
export const loggerAuditSink = {
    record(entry) {
        logger.info({
            ...originLogFields(entry.origin),
            call_id: entry.callId,
            domain: entry.domain,
            method: entry.method,
            ...(entry.agent
                ? { agent_type: entry.agent.agentType, agent_id: entry.agent.agentId ?? null }
                : {}),
            ...(entry.model ? { model: entry.model } : {}),
            ...(entry.usage ? { usage: entry.usage } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.errorKind ? { error_kind: entry.errorKind } : {}),
            ...mcpLogFields(entry),
            outcome: entry.outcome.status,
            outcome_code: entry.outcome.code ?? null,
            outcome_dispatch: entry.outcome.dispatch ?? null,
            outcome_stamped_at: entry.outcome.stampedAt,
            duration_ms: entry.durationMs,
        }, 'plugin-extension.audit');
    },
};
function originLogFields(origin) {
    if (!origin)
        return { plugin_id: null, session_id: null };
    return {
        plugin_id: origin.pluginId,
        plugin_source: origin.source,
        artifact_digest: origin.artifactDigest,
        session_id: origin.sessionId,
        slot: origin.slot,
        site_key: origin.key,
    };
}
function mcpLogFields(entry) {
    if (!entry.mcp)
        return {};
    return {
        mcp_server: entry.mcp.server,
        mcp_tool: entry.mcp.tool,
        mcp_assigned_name: entry.mcp.assignedName ?? null,
        mcp_target_plugin: entry.mcp.targetPlugin ?? null,
        ...(entry.mcpResult
            ? {
                mcp_result_is_error: entry.mcpResult.isError === true,
                mcp_result_items: entry.mcpResult.content.length,
            }
            : {}),
    };
}
//# sourceMappingURL=call-boundary.js.map