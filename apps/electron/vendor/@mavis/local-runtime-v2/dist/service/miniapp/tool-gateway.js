import { ConnectorGatewayError, } from '../host-connector-system/index.js';
import { MiniAppToolError, MINIAPP_TOOL_CALL_PERMISSION, MINIAPP_TOOL_REQUEST_MAX_NAMES, } from './contracts.js';
import { raceWithSignal } from './process/host-connector/host-connector-abort.js';
import { isMiniAppToolNameWithinLimit } from './process/host-connector/host-connector-wire.js';
import { currentMiniAppToolRules, judgeMiniAppToolCall, requestMiniAppToolPermissions, } from './tool-permission.js';
const DEFAULT_ABORT_GRACE_MS = 250;
const DEFAULT_CONNECTOR_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Host-side `context.tool`: the installed MCP and Connector tools, judged by the Host's rules. */
export function createMiniAppToolGateway(options) {
    // The newest open session per plugin; a page request runs on it.
    const live = new Map();
    return {
        open: (input) => {
            const session = new ToolSession(options, input.caller, () => {
                if (live.get(input.caller.pluginId) === session)
                    live.delete(input.caller.pluginId);
            });
            live.set(input.caller.pluginId, session);
            return session;
        },
        requestForPlugin: async (input) => {
            const session = live.get(input.pluginId);
            if (!session)
                throw new MiniAppToolError('TOOL_UNAVAILABLE', 'not_dispatched', true);
            return session.request({ names: input.names, signal: input.signal });
        },
    };
}
/** Raised inside the session when one of its own phase bounds fired. */
class ToolPhaseTimeout extends Error {
    disposition;
    name = 'ToolPhaseTimeout';
    /** The verdict of the operation the bound interrupted, when it gave one. */
    constructor(disposition) {
        super('Mini App tool phase timed out');
        this.disposition = disposition;
    }
}
class ToolSession {
    options;
    caller;
    onRelease;
    #targets = new Map();
    #connectorListing;
    #hostCaller;
    constructor(options, caller, onRelease) {
        this.options = options;
        this.caller = caller;
        this.onRelease = onRelease;
        this.#hostCaller = { kind: 'host-process', ...caller };
    }
    admit(name) {
        if (!this.#switchedOn())
            return new MiniAppToolError('TOOL_NOT_PERMITTED');
        return isMiniAppToolNameWithinLimit(name)
            ? undefined
            : new MiniAppToolError('INVALID_ARGUMENTS');
    }
    async list(input) {
        input.onDispatch();
        const listing = await this.#listAll(input.signal);
        // With `tool:call` off every call would be refused, whatever the rules say.
        const rules = this.#switchedOn()
            ? await currentMiniAppToolRules(listing.targets, this.options.permissions)
            : undefined;
        const tools = [];
        for (const [index, tool] of listing.tools.entries()) {
            if (!listing.targets[index])
                continue;
            tools.push({ ...tool, permission: rules ? (rules[index] ?? 'ask') : 'deny' });
        }
        return { tools, partial: listing.partial };
    }
    async request(input) {
        const startedAtMs = this.#nowMs();
        const names = isRequestNames(input.names) ? input.names : undefined;
        try {
            if (!names)
                throw new MiniAppToolError('INVALID_ARGUMENTS');
            // With `tool:call` off nothing could be allowed: answer deny without a prompt.
            if (!this.#switchedOn()) {
                this.#auditRequest(names, startedAtMs, 'completed', 'TOOL_NOT_PERMITTED');
                return {
                    permissions: Object.fromEntries(names.map((name) => [name, 'deny'])),
                    approvalRequired: false,
                };
            }
            const targets = await this.#phase(input.signal, this.#timeouts().mcpMs, async (signal) => {
                const resolved = [];
                for (const name of names)
                    resolved.push(await this.#resolve(name, signal));
                return resolved;
            });
            const result = await this.#phase(input.signal, this.#timeouts().approvalMs, (signal) => requestMiniAppToolPermissions(this.#ports(), {
                targets,
                pluginId: this.caller.pluginId,
                signal,
            }));
            this.#auditRequest(names, startedAtMs, 'completed');
            return result;
        }
        catch (error) {
            const failure = callFailure(error, false);
            this.#auditRequest(names ?? [], startedAtMs, failure.disposition, failure.code);
            throw failure.error;
        }
    }
    async call(input) {
        const startedAtMs = this.#nowMs();
        const judgement = {};
        let target;
        let dispatched = false;
        try {
            target = await this.#phase(input.signal, this.#callMs(input.name), (signal) => this.#resolve(input.name, signal));
            const resolved = target;
            await this.#phase(input.signal, this.#timeouts().approvalMs, (signal) => judgeMiniAppToolCall(this.#ports(), {
                target: resolved,
                pluginId: this.caller.pluginId,
                arguments: input.arguments,
                signal,
                judgement,
            }));
            if (input.signal.aborted)
                throw new MiniAppToolError('REQUEST_CANCELLED');
            // The switch may have gone off while the prompt was open.
            if (!this.#switchedOn())
                throw new MiniAppToolError('TOOL_NOT_PERMITTED');
            // Dispatch is not raced: each owner settles an abort itself and says whether it ran.
            const result = await this.#phase(input.signal, this.#callMs(input.name), (signal) => this.#dispatch(resolved, input, signal, () => {
                input.onDispatch();
                dispatched = true;
            }), false);
            this.#audit(input, { startedAtMs, judgement, target, outcome: toolOutcome(result) });
            return result;
        }
        catch (error) {
            const failure = callFailure(error, dispatched);
            this.#audit(input, {
                startedAtMs,
                judgement,
                target,
                outcome: failure.disposition,
                ...(failure.code ? { code: failure.code } : {}),
            });
            throw failure.error;
        }
    }
    release() {
        this.#targets = new Map();
        this.onRelease();
    }
    /**
     * A name absent from the last listing gets one fresh listing before it counts as unknown. The
     * `tool:call` switch is read here, at every admission of a call or request.
     */
    async #resolve(name, signal) {
        if (!this.#switchedOn())
            throw new MiniAppToolError('TOOL_NOT_PERMITTED');
        const target = this.#targets.get(name) ?? (await this.#refreshFor(name, signal));
        if (!target)
            throw new MiniAppToolError('INVALID_ARGUMENTS');
        return target;
    }
    async #refreshFor(name, signal) {
        await this.#listAll(signal);
        return this.#targets.get(name);
    }
    async #listAll(signal) {
        const settled = await Promise.allSettled([
            this.#listMcp(this.options.localMcp),
            this.#listMcp(this.options.pluginMcp),
            this.#listConnector(signal),
        ]);
        const listed = settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
        const failure = settled.find((result) => result.status === 'rejected');
        if (listed.length === 0 && failure?.status === 'rejected')
            throw failure.reason;
        const merged = mergeListings(listed);
        this.#targets = new Map(merged.targets.map((target) => [target.name, target]));
        return { ...merged, partial: merged.partial || failure !== undefined };
    }
    async #listMcp(source) {
        if (!source)
            return undefined;
        const inventory = await source.list();
        const tools = [];
        const targets = [];
        let partial = inventory.partial;
        for (const tool of inventory.tools) {
            const inputSchema = toJson(tool.inputSchema);
            if (inputSchema === undefined || !isMiniAppToolNameWithinLimit(tool.name)) {
                partial = true;
                continue;
            }
            tools.push({
                name: tool.name,
                kind: 'mcp',
                server: tool.server,
                tool: tool.tool,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema,
            });
            targets.push({
                name: tool.name,
                kind: 'mcp',
                owner: tool.server,
                tool: tool.tool,
                builtin: tool.builtin === true,
                source,
            });
        }
        return { tools, targets, partial };
    }
    /**
     * The Connector gateway keeps one inventory per process and each listing supersedes the
     * previous one's handles, so concurrent listings would invalidate each other's calls. Callers
     * share the listing in flight; it is aborted only when every caller has given up.
     */
    async #listConnector(signal) {
        const listing = this.#connectorListing ?? this.#startConnectorListing();
        listing.waiters += 1;
        try {
            const outcome = await raceWithSignal(listing.outcome, signal);
            if (!outcome.ok)
                throw outcome.error;
            return outcome.listing;
        }
        finally {
            listing.waiters -= 1;
            if (listing.waiters === 0 && signal.aborted) {
                if (this.#connectorListing === listing)
                    this.#connectorListing = undefined;
                listing.controller.abort(signal.reason);
            }
        }
    }
    #startConnectorListing() {
        const controller = new AbortController();
        const listing = {
            outcome: this.#runConnectorListing(controller.signal, () => listing),
            controller,
            waiters: 0,
        };
        this.#connectorListing = listing;
        return listing;
    }
    async #runConnectorListing(signal, self) {
        try {
            return { ok: true, listing: await this.#fetchConnectorInventory(signal) };
        }
        catch (error) {
            return { ok: false, error };
        }
        finally {
            if (this.#connectorListing === self())
                this.#connectorListing = undefined;
        }
    }
    async #fetchConnectorInventory(signal) {
        // Every connected provider: the account's Connector grants are the only provider filter.
        const inventory = await this.options.connectorGateway.list({
            providerAllowlist: 'all',
            caller: this.#hostCaller,
            signal,
        });
        const tools = [];
        const targets = [];
        let partial = inventory.partial;
        for (const tool of inventory.tools) {
            const inputSchema = parseJson(tool.inputSchemaJson);
            // The child rejects the whole list over one oversized name; skip it like a bad schema.
            if (inputSchema === undefined || !isMiniAppToolNameWithinLimit(tool.runtimeToolName)) {
                partial = true;
                continue;
            }
            tools.push({
                name: tool.runtimeToolName,
                kind: 'connector',
                provider: tool.provider,
                tool: tool.providerToolName,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema,
            });
            targets.push({
                name: tool.runtimeToolName,
                kind: 'connector',
                owner: tool.provider,
                tool: tool.providerToolName,
                builtin: false,
                handle: tool.handle,
            });
        }
        return { tools, targets, partial };
    }
    #dispatch(target, input, signal, onDispatch) {
        return target.kind === 'connector'
            ? this.#callConnector(target, input, signal, onDispatch)
            : this.#callMcp(target.source, input, signal, onDispatch);
    }
    /** A handle superseded by another listing never reached the Connector: relist once, retry once. */
    async #callConnector(target, input, signal, onDispatch) {
        try {
            return await this.#callConnectorOnce(target.handle, input, signal, onDispatch);
        }
        catch (error) {
            if (!isStaleHandle(error))
                throw error;
        }
        const fresh = await this.#refreshFor(input.name, signal);
        if (fresh?.kind !== 'connector')
            throw new MiniAppToolError('TOOL_REF_STALE');
        try {
            return await this.#callConnectorOnce(fresh.handle, input, signal, onDispatch);
        }
        catch (error) {
            if (isStaleHandle(error))
                throw new MiniAppToolError('TOOL_REF_STALE');
            throw error;
        }
    }
    async #callConnectorOnce(handle, input, signal, onDispatch) {
        if (signal.aborted)
            throw signal.reason;
        onDispatch();
        const result = await raceWithSignal(this.options.connectorGateway.call({
            handle,
            arguments: input.arguments,
            caller: this.#hostCaller,
            hostRequest: { clientRequestId: input.clientRequestId, invocationId: input.invocationId },
            signal,
        }), signal);
        if (result.isError) {
            throw new ConnectorGatewayError('CONNECTOR_PROVIDER_ERROR', 'Connector provider reported an error', 'provider_reported', input.invocationId);
        }
        const value = parseJson(result.resultJson ?? 'null');
        if (value === undefined) {
            throw new MiniAppToolError('TOOL_OUTCOME_UNKNOWN', 'unknown_after_dispatch');
        }
        return { kind: 'connector', value };
    }
    async #callMcp(source, input, signal, onDispatch) {
        onDispatch();
        const outcome = await settleWithAbortGrace(source.call({
            pluginId: this.caller.pluginId,
            name: input.name,
            arguments: input.arguments,
            signal,
        }), signal, this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
        return projectMcpOutcome(outcome);
    }
    /**
     * Runs one phase under its own bound and the caller's cancellation. A fired bound becomes
     * `ToolPhaseTimeout`; the error the operation settles with is kept otherwise.
     */
    async #phase(signal, timeoutMs, operation, race = true) {
        const bound = new AbortController();
        const timer = setTimeout(() => bound.abort(new ToolPhaseTimeout()), Math.max(1, timeoutMs));
        timer.unref();
        const combined = AbortSignal.any([signal, bound.signal]);
        try {
            // Never start an operation the race would not subscribe to.
            if (race)
                combined.throwIfAborted();
            const running = operation(combined);
            return await (race ? raceWithSignal(running, combined) : running);
        }
        catch (error) {
            if (!bound.signal.aborted || signal.aborted)
                throw error;
            throw new ToolPhaseTimeout(errorDisposition(error));
        }
        finally {
            clearTimeout(timer);
        }
    }
    #callMs(name) {
        const timeouts = this.#timeouts();
        return name.startsWith('connector__') ? timeouts.connectorMs : timeouts.mcpMs;
    }
    #timeouts() {
        const timeouts = this.options.timeouts;
        return {
            connectorMs: timeouts?.connectorMs ?? DEFAULT_CONNECTOR_CALL_TIMEOUT_MS,
            mcpMs: timeouts?.mcpMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
            approvalMs: timeouts?.approvalMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        };
    }
    #switchedOn() {
        const switches = this.options.permissionSwitches;
        return !switches || switches.isEnabled(this.caller.pluginId, MINIAPP_TOOL_CALL_PERMISSION);
    }
    #nowMs() {
        return (this.options.nowMs ?? Date.now)();
    }
    #ports() {
        return { permissions: this.options.permissions, approvals: this.options.approvals };
    }
    #auditRequest(names, startedAtMs, outcome, code) {
        const finishedAtMs = this.#nowMs();
        try {
            this.options.audit?.record({
                action: 'request',
                timestampMs: finishedAtMs,
                invocationId: '',
                callerKind: 'host-process',
                ...this.caller,
                clientRequestId: '',
                name: names.join(','),
                outcome,
                ...(code ? { code } : {}),
                durationMs: finishedAtMs - startedAtMs,
            });
        }
        catch {
            // Audit is log-only.
        }
    }
    #audit(input, result) {
        const { startedAtMs, judgement, target, outcome, code } = result;
        const finishedAtMs = this.#nowMs();
        try {
            this.options.audit?.record({
                timestampMs: finishedAtMs,
                invocationId: input.invocationId,
                callerKind: 'host-process',
                ...this.caller,
                clientRequestId: input.clientRequestId,
                name: input.name,
                ...(target ? { kind: target.kind } : {}),
                ...(judgement.rule ? { rule: judgement.rule } : {}),
                ...(judgement.decision ? { decision: judgement.decision } : {}),
                ...(judgement.ruleWriteFailed ? { ruleWriteFailed: true } : {}),
                outcome,
                ...(code ? { code } : {}),
                durationMs: finishedAtMs - startedAtMs,
            });
        }
        catch {
            // Audit is log-only; a failing logger must not change the call outcome.
        }
    }
}
/** First source wins a runtime name, the order an Agent turn assembles them in. */
function mergeListings(listings) {
    const names = new Set();
    const tools = [];
    const targets = [];
    let partial = false;
    for (const listing of listings) {
        partial ||= listing.partial;
        listing.tools.forEach((tool, index) => {
            const target = listing.targets[index];
            if (!target || names.has(tool.name))
                return;
            names.add(tool.name);
            tools.push(tool);
            targets.push(target);
        });
    }
    return { tools, targets, partial };
}
function isRequestNames(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MINIAPP_TOOL_REQUEST_MAX_NAMES &&
        new Set(value).size === value.length &&
        value.every(isMiniAppToolNameWithinLimit));
}
function toolOutcome(result) {
    return result.kind === 'mcp' && result.isError ? 'tool_reported' : 'completed';
}
/**
 * A fired phase bound is `TOOL_TIMEOUT`; whether it may have run is the disposition, and only
 * a timeout before dispatch is safe to retry. Other errors keep their own verdict.
 */
function callFailure(error, dispatched) {
    const fallback = dispatched ? 'unknown_after_dispatch' : 'not_dispatched';
    if (error instanceof ToolPhaseTimeout) {
        const disposition = error.disposition ?? fallback;
        return {
            error: new MiniAppToolError('TOOL_TIMEOUT', disposition, disposition === 'not_dispatched'),
            disposition,
            code: 'TOOL_TIMEOUT',
        };
    }
    const code = error instanceof MiniAppToolError || error instanceof ConnectorGatewayError
        ? error.code
        : undefined;
    return { error, disposition: errorDisposition(error) ?? fallback, ...(code ? { code } : {}) };
}
function errorDisposition(error) {
    if (error instanceof MiniAppToolError)
        return error.disposition;
    if (!(error instanceof ConnectorGatewayError))
        return undefined;
    return error.outcome === 'not_dispatched' ? 'not_dispatched' : 'unknown_after_dispatch';
}
function isStaleHandle(error) {
    return (error instanceof ConnectorGatewayError &&
        error.code === 'CONNECTOR_TOOL_HANDLE_INVALID' &&
        error.outcome === 'not_dispatched');
}
/** An MCP refusal keeps its disposition; content that is not plain JSON is an unknown outcome. */
function projectMcpOutcome(outcome) {
    if (!outcome.ok) {
        throw new MiniAppToolError(outcome.code, outcome.disposition, outcome.code === 'MCP_SERVER_UNAVAILABLE');
    }
    const content = toJson(outcome.content);
    const structuredContent = outcome.structuredContent === undefined ? undefined : toJson(outcome.structuredContent);
    if (!Array.isArray(content) || (outcome.structuredContent && !isJsonObject(structuredContent))) {
        throw new MiniAppToolError('TOOL_OUTCOME_UNKNOWN', 'unknown_after_dispatch');
    }
    return {
        kind: 'mcp',
        isError: outcome.isError,
        content,
        ...(isJsonObject(structuredContent) ? { structuredContent } : {}),
    };
}
/**
 * An aborted MCP call usually settles at once and says whether it dispatched; a call that does
 * not settle within the grace period is abandoned with the abort reason.
 */
async function settleWithAbortGrace(operation, signal, graceMs) {
    let timer;
    let rejectAbandoned = () => undefined;
    const abandoned = new Promise((_resolve, reject) => {
        rejectAbandoned = reject;
    });
    const onAbort = () => {
        timer = setTimeout(() => rejectAbandoned(signal.reason), Math.max(0, graceMs));
        timer.unref();
    };
    if (signal.aborted)
        onAbort();
    else
        signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([operation, abandoned]);
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
    }
}
function parseJson(json) {
    try {
        return JSON.parse(json);
    }
    catch {
        return undefined;
    }
}
/** Plain-JSON copy; `undefined` when the value cannot cross the process boundary as JSON. */
function toJson(value) {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? undefined : JSON.parse(json);
    }
    catch {
        return undefined;
    }
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=tool-gateway.js.map