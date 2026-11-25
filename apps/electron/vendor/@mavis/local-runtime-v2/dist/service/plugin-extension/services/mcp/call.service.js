import { pluginMcpRuleSubject } from '../../../turn-system/index.js';
import { ExtensionServiceError } from '../../errors.js';
import { isJsonObject } from '../../json-value.js';
import { EXTENSION_QUOTAS, PerPluginRateLimiter } from '../quota.js';
import { resolveMcpServer } from './resolution.js';
/**
 * `ctx.mcp.call`: quota → name resolution → generation lease → permission (same rules as the
 * agent, identity `(owner plugin, server, tool)`) → dispatch. Everything before the owner's
 * dispatch is `not_dispatched`; the outcome after it is whatever the owner stamped.
 */
export class ExtensionMcpCallService {
    deps;
    quota;
    constructor(deps) {
        this.deps = deps;
        this.quota = new PerPluginRateLimiter(EXTENSION_QUOTAS.mcpCall, deps.nowMs);
    }
    async call(callId, input) {
        return this.deps.boundary.run({ callId, domain: 'mcp', method: 'call' }, async (invocation, detail) => {
            detail.mcp = { server: String(input.server), tool: String(input.tool) };
            detail.dispatch = 'not_dispatched';
            const request = readRequest(input, invocation);
            if (!this.quota.tryTake(invocation.origin.pluginId)) {
                throw notDispatched('MCP_CALL_RATE_LIMITED', 'mcp.call exceeded 60 per minute');
            }
            const target = resolveMcpServer(invocation.origin, request.server, await this.listTargets(invocation.origin.sessionId));
            detail.mcp = {
                ...detail.mcp,
                assignedName: target.assignedName,
                ...(target.owner.kind === 'plugin'
                    ? { targetPlugin: target.owner.activation.pluginId }
                    : {}),
            };
            this.lease(target);
            try {
                return await this.authorizeAndDispatch({ invocation, target, request, detail });
            }
            finally {
                this.deps.targets.release(target);
            }
        });
    }
    async listTargets(sessionId) {
        try {
            return await this.deps.targets.list(sessionId);
        }
        catch {
            throw notDispatched('MCP_CALL_FAILED', 'the MCP server inventory is unavailable');
        }
    }
    lease(target) {
        try {
            this.deps.targets.retain(target);
        }
        catch {
            throw notDispatched('MCP_CALL_FAILED', 'the MCP server generation is no longer available');
        }
    }
    async authorizeAndDispatch(input) {
        const { invocation, target, request, detail } = input;
        let described;
        try {
            described = await this.deps.targets.describeTool(target, request.tool);
        }
        catch {
            described = undefined;
        }
        if (!described) {
            throw notDispatched('MCP_CALL_FAILED', `MCP tool "${request.tool}" not found on "${request.server}"`);
        }
        await this.authorize(invocation, target, request, described);
        if (request.signal?.aborted)
            throw notDispatched('MCP_CALL_FAILED', 'mcp.call aborted before dispatch');
        let dispatched;
        try {
            dispatched = await this.deps.targets.dispatch({
                caller: invocation.origin.pluginId,
                target,
                tool: request.tool,
                args: request.args,
                ...(request.signal ? { signal: request.signal } : {}),
            });
        }
        catch {
            dispatched = { status: 'unknown_after_dispatch', message: 'MCP dispatch failed' };
        }
        if (dispatched.status !== 'returned') {
            detail.dispatch = dispatched.status;
            throw new ExtensionServiceError('MCP_CALL_FAILED', dispatched.message, dispatched.status);
        }
        detail.mcpResult = dispatched.result;
        if (dispatched.result.isError === true) {
            detail.dispatch = 'provider_reported';
            detail.status = 'error';
        }
        else {
            delete detail.dispatch;
        }
        return dispatched.result;
    }
    async authorize(invocation, target, request, described) {
        let behavior;
        try {
            behavior = await this.deps.permission.decide({
                sessionId: invocation.origin.sessionId,
                toolRuntimeName: described.runtimeName,
                args: request.args,
                subject: ruleSubject(target, request.tool),
            });
        }
        catch {
            throw notDispatched('PERMISSION_REQUIRED', 'the permission check failed');
        }
        if (behavior === 'deny')
            throw notDispatched('PERMISSION_DENIED', 'denied by a permission rule');
        if (behavior === 'allow')
            return;
        // A drawing asks like any Invocation. Its signal ends with the drawing (render deadline or a
        // newer drawing), which withdraws the card and settles the call with `CANCELLED`.
        await this.awaitApproval(invocation, request, described.runtimeName);
    }
    async awaitApproval(invocation, request, toolRuntimeName) {
        if (request.signal?.aborted)
            throw notDispatched('CANCELLED', 'cancelled before the authorization card was shown');
        let decision;
        try {
            decision = await this.deps.permission.approve({
                sessionId: invocation.origin.sessionId,
                pluginId: invocation.origin.pluginId,
                callId: invocation.callId,
                toolRuntimeName,
                args: request.args,
                ...(request.signal ? { signal: request.signal } : {}),
            });
        }
        catch {
            if (request.signal?.aborted)
                throw notDispatched('CANCELLED', 'cancelled while waiting for authorization');
            throw notDispatched('PERMISSION_REQUIRED', 'the authorization request failed');
        }
        if (request.signal?.aborted)
            throw notDispatched('CANCELLED', 'cancelled while waiting for authorization');
        if (decision !== 'allow')
            throw notDispatched('PERMISSION_DENIED', 'denied by the user or the wait was ended');
    }
}
/** Rule identity: the server's owning activation (not the caller), its declared name and the tool. */
function ruleSubject(target, tool) {
    if (target.owner.kind === 'configured')
        return { server: target.server, tool, inheritAllow: true };
    return pluginMcpRuleSubject(target.owner.activation, target.server, tool);
}
function readRequest(input, invocation) {
    const args = input.args ?? {};
    if (typeof input.server !== 'string' ||
        typeof input.tool !== 'string' ||
        !input.server ||
        !input.tool ||
        !isJsonObject(args)) {
        throw notDispatched('ARGUMENT_INVALID', 'mcp.call takes (server, tool, args?: object)');
    }
    const signals = [input.signal, invocation.signal].filter((signal) => signal !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return { server: input.server, tool: input.tool, args, ...(signal ? { signal } : {}) };
}
function notDispatched(code, message) {
    return new ExtensionServiceError(code, message, 'not_dispatched');
}
//# sourceMappingURL=call.service.js.map