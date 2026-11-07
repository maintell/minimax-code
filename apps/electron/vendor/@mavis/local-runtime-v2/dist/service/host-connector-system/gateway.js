import { performance } from 'node:perf_hooks';
import { compileConnectorArgumentsValidator } from './arguments-validator.js';
import { ConnectorGatewayError } from './errors.js';
const CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;
const CONNECTOR_INVOCATION_ID_MAX_BYTES = 256;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
export class HostConnectorGateway {
    options;
    grants = new WeakMap();
    inFlight = new Set();
    pending = new Set();
    nowMs;
    drainTimeoutMs;
    principalEpoch = 0;
    inventoryRevision = 0;
    credential;
    epochController = new AbortController();
    terminalAudits = new Set();
    hostProcessSlots = new Map();
    registeredHostProcessKeys = new Set();
    releasedHostProcessKeys = new Set();
    lastAuthenticatedPrincipalId;
    closed = false;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
        const authContext = captureAuthContext(options.credentialGetter());
        this.credential = authContext.credential;
        this.lastAuthenticatedPrincipalId = authContext.credential?.realUserID;
    }
    registerHostProcess(input) {
        this.assertOpen();
        const caller = captureHostProcessCaller({ kind: 'host-process', ...input });
        const key = hostInventoryKey(caller);
        if (this.releasedHostProcessKeys.has(key)) {
            throw new ConnectorGatewayError('CONNECTOR_HOST_PROCESS_RELEASED', 'Host process generation was already released', 'not_dispatched');
        }
        this.registeredHostProcessKeys.add(key);
    }
    async list(input) {
        this.assertOpen();
        throwIfAborted(input.signal);
        const credential = this.requireCredential();
        const principalEpoch = this.principalEpoch;
        const epochSignal = this.epochController.signal;
        const allowedProviders = providerAllowlist(input.providerAllowlist);
        const hostAdmission = this.captureHostListAdmission(input.caller);
        if (allowedProviders?.size === 0) {
            this.publishHostInventory(hostAdmission, ++this.inventoryRevision, new Map());
            return Object.freeze({
                tools: Object.freeze([]),
                providerFailures: Object.freeze([]),
                partial: false,
            });
        }
        const result = await this.options.client.listConnectedTools({
            credential,
            signal: combineSignals(input.signal, epochSignal),
        });
        this.assertEpochCurrent(principalEpoch, undefined, 'not_dispatched');
        this.assertHostAdmissionCurrent(hostAdmission);
        const descriptors = result.tools.filter((descriptor) => CONNECTOR_PROVIDER.test(descriptor.provider) &&
            (allowedProviders?.has(descriptor.provider) ?? true));
        const providerFailures = result.providerFailures
            .filter((failure) => CONNECTOR_PROVIDER.test(failure.provider) &&
            (allowedProviders?.has(failure.provider) ?? true))
            .map((failure) => ({
            provider: failure.provider,
            code: failure.code,
            ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        }));
        const inventoryRevision = ++this.inventoryRevision;
        const tools = [];
        const preparedGrants = [];
        const hostToolHandles = new Map();
        for (const descriptor of descriptors) {
            const handle = this.hostToolHandleForRefresh(hostAdmission, hostToolHandles, descriptor);
            preparedGrants.push([
                handle,
                {
                    principalEpoch,
                    inventoryRevision,
                    descriptor,
                    callerBinding: hostAdmission.caller,
                    argumentsValidator: compileConnectorArgumentsValidator(descriptor.inputSchemaJson),
                },
            ]);
            tools.push(Object.freeze({ ...descriptor, handle }));
        }
        this.assertHostAdmissionCurrent(hostAdmission);
        for (const [handle, grant] of preparedGrants)
            this.grants.set(handle, grant);
        this.publishHostInventory(hostAdmission, inventoryRevision, hostToolHandles);
        return Object.freeze({
            tools: Object.freeze(tools),
            providerFailures: Object.freeze(providerFailures),
            partial: result.partial || providerFailures.length > 0,
        });
    }
    async call(input) {
        const completion = deferredCompletion();
        this.pending.add(completion.promise);
        try {
            return await this.performCall(input);
        }
        finally {
            this.pending.delete(completion.promise);
            completion.resolve();
        }
    }
    authContextChanged() {
        if (this.closed)
            return;
        const authContext = captureAuthContext(this.options.credentialGetter());
        this.principalEpoch += 1;
        const oldController = this.epochController;
        this.epochController = new AbortController();
        this.credential = authContext.credential;
        oldController.abort();
        for (const call of this.inFlight.values())
            call.controller.abort();
        this.revokeHostProcessSlots();
        const nextPrincipalId = authContext.credential?.realUserID;
        if (!nextPrincipalId)
            return;
        // Logout revokes grants, not the running process. The same account must relist
        // under the new epoch; a different account permanently fences every old process.
        if (this.lastAuthenticatedPrincipalId !== undefined &&
            nextPrincipalId !== this.lastAuthenticatedPrincipalId) {
            this.releaseRegisteredHostProcesses();
        }
        this.lastAuthenticatedPrincipalId = nextPrincipalId;
    }
    releaseHostProcess(input) {
        if (this.closed)
            return;
        const key = hostInventoryKey({ kind: 'host-process', ...input });
        this.releasedHostProcessKeys.add(key);
        this.registeredHostProcessKeys.delete(key);
        const slot = this.hostProcessSlots.get(key);
        if (!slot)
            return;
        this.releaseHostProcessSlot(slot);
        this.hostProcessSlots.delete(key);
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.principalEpoch += 1;
        this.epochController.abort();
        for (const call of this.inFlight)
            call.controller.abort();
        this.revokeHostProcessSlots();
        this.registeredHostProcessKeys.clear();
        this.releasedHostProcessKeys.clear();
        const deadlineMs = performance.now() + this.drainTimeoutMs;
        await drainWithin([...this.pending], remainingMs(deadlineMs));
        await drainWithin([...this.terminalAudits], remainingMs(deadlineMs));
    }
    async performCall(input) {
        this.assertOpen();
        throwIfAborted(input.signal);
        const grant = this.grants.get(input.handle);
        if (!grant) {
            throw new ConnectorGatewayError('CONNECTOR_TOOL_HANDLE_INVALID', 'Connector tool handle is invalid', 'not_dispatched');
        }
        this.assertEpochCurrent(grant.principalEpoch, undefined, 'not_dispatched');
        assertCallerBinding(grant.callerBinding, input.caller);
        const hostAdmission = this.captureHostCallAdmission(grant, input.caller);
        const credential = this.requireCredential();
        const invocationId = invocationIdForCall(input.hostRequest);
        const clientRequestId = input.hostRequest.clientRequestId;
        const startedAtMs = this.nowMs();
        const controller = new AbortController();
        const signal = combineSignals(input.signal, this.epochController.signal, controller.signal);
        const activeCall = { controller, hostAdmission };
        this.inFlight.add(activeCall);
        hostAdmission.slot.activeCalls.add(activeCall);
        let dispatched = false;
        let terminalAuditRecorded = false;
        try {
            await this.recordAdmission({
                phase: 'admission',
                timestampMs: startedAtMs,
                invocationId,
                principalEpoch: grant.principalEpoch,
                inventoryRevision: grant.inventoryRevision,
                callerKind: 'host-process',
                ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
                provider: grant.descriptor.provider,
                tool: grant.descriptor.providerToolName,
                outcome: 'not_dispatched',
            });
            this.assertEpochCurrent(grant.principalEpoch, invocationId, 'not_dispatched');
            this.assertHostCallDispatchCurrent(hostAdmission, invocationId);
            throwIfAborted(signal, invocationId);
            const validationIssues = grant.argumentsValidator?.validate(input.arguments);
            if (validationIssues) {
                throw new ConnectorGatewayError('CONNECTOR_ARGUMENTS_INVALID', 'Connector arguments are invalid', 'not_dispatched', {
                    invocationId,
                    diagnostic: Object.freeze({ issues: validationIssues }),
                });
            }
            const result = await this.options.client.callTool({
                credential,
                provider: grant.descriptor.provider,
                providerToolName: grant.descriptor.providerToolName,
                runtimeToolName: grant.descriptor.runtimeToolName,
                arguments: input.arguments,
                requestId: invocationId,
                signal,
                onDispatch: () => {
                    dispatched = true;
                    this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
                },
            });
            this.assertEpochCurrent(grant.principalEpoch, invocationId, 'unknown_after_dispatch');
            this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
            await this.recordTerminal(auditTerminal({
                grant,
                callerKind: 'host-process',
                ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
                invocationId,
                startedAtMs,
                finishedAtMs: this.nowMs(),
                outcome: result.isError === true ? 'provider_reported' : 'completed',
            }));
            terminalAuditRecorded = true;
            this.assertEpochCurrent(grant.principalEpoch, invocationId, 'unknown_after_dispatch');
            this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
            return result;
        }
        catch (error) {
            let normalized;
            try {
                const outcome = dispatched ? 'unknown_after_dispatch' : 'not_dispatched';
                this.assertEpochCurrent(grant.principalEpoch, invocationId, outcome);
                this.assertHostCallCurrent(hostAdmission, invocationId, outcome);
                normalized = normalizeCallError(error, dispatched, invocationId);
            }
            catch (fenceError) {
                normalized = normalizeCallError(fenceError, dispatched, invocationId);
            }
            if (!terminalAuditRecorded) {
                await this.recordTerminal(auditTerminal({
                    grant,
                    callerKind: 'host-process',
                    ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
                    invocationId,
                    startedAtMs,
                    finishedAtMs: this.nowMs(),
                    outcome: normalized.outcome,
                    code: normalized.code,
                }));
                const outcome = dispatched ? 'unknown_after_dispatch' : 'not_dispatched';
                this.assertEpochCurrent(grant.principalEpoch, invocationId, outcome);
                this.assertHostCallCurrent(hostAdmission, invocationId, outcome);
            }
            throw normalized;
        }
        finally {
            hostAdmission.slot.activeCalls.delete(activeCall);
            this.inFlight.delete(activeCall);
        }
    }
    requireCredential() {
        if (this.credential)
            return this.credential;
        throw new ConnectorGatewayError('AUTH_REQUIRED', 'Connector access requires login', 'not_dispatched');
    }
    captureHostListAdmission(caller) {
        const capturedCaller = captureHostProcessCaller(caller);
        const key = hostInventoryKey(capturedCaller);
        if (this.releasedHostProcessKeys.has(key)) {
            throw new ConnectorGatewayError('CONNECTOR_HOST_PROCESS_RELEASED', 'Host process generation was already released', 'not_dispatched');
        }
        if (!this.registeredHostProcessKeys.has(key)) {
            throw new ConnectorGatewayError('CONNECTOR_HOST_PROCESS_NOT_REGISTERED', 'Host process generation was not registered', 'not_dispatched');
        }
        let slot = this.hostProcessSlots.get(key);
        if (!slot || slot.released) {
            slot = { released: false, activeCalls: new Set(), toolHandles: new Map() };
            this.hostProcessSlots.set(key, slot);
        }
        const listToken = {};
        slot.currentListToken = listToken;
        return { caller: capturedCaller, key, slot, listToken };
    }
    publishHostInventory(admission, inventoryRevision, toolHandles) {
        this.assertHostAdmissionCurrent(admission);
        admission.slot.toolHandles = toolHandles;
        admission.slot.inventoryRevision = inventoryRevision;
    }
    hostToolHandleForRefresh(admission, nextHandles, descriptor) {
        const identity = connectorToolIdentity(descriptor);
        const reusable = nextHandles.has(identity)
            ? undefined
            : admission.slot.toolHandles.get(identity);
        const handle = reusable ?? Object.freeze({});
        nextHandles.set(identity, handle);
        return handle;
    }
    assertHostAdmissionCurrent(admission) {
        const current = this.hostProcessSlots.get(admission.key);
        if (current === admission.slot &&
            !admission.slot.released &&
            admission.slot.currentListToken === admission.listToken) {
            return;
        }
        throw new ConnectorGatewayError('CONNECTOR_HOST_PROCESS_RELEASED', 'Host process was released before Connector inventory publication', 'not_dispatched');
    }
    revokeHostProcessSlots() {
        for (const slot of this.hostProcessSlots.values()) {
            this.releaseHostProcessSlot(slot);
        }
        this.hostProcessSlots.clear();
    }
    releaseRegisteredHostProcesses() {
        for (const key of this.registeredHostProcessKeys)
            this.releasedHostProcessKeys.add(key);
        this.registeredHostProcessKeys.clear();
    }
    captureHostCallAdmission(grant, caller) {
        const capturedCaller = captureHostProcessCaller(caller);
        const key = hostInventoryKey(capturedCaller);
        const slot = this.hostProcessSlots.get(key);
        if (!slot?.released && slot?.inventoryRevision === grant.inventoryRevision) {
            return { caller: capturedCaller, key, slot, inventoryRevision: grant.inventoryRevision };
        }
        throw new ConnectorGatewayError('CONNECTOR_TOOL_HANDLE_INVALID', 'Connector tool handle is stale for this Host inventory', 'not_dispatched');
    }
    assertHostCallDispatchCurrent(admission, invocationId) {
        this.assertHostCallCurrent(admission, invocationId, 'not_dispatched');
        if (admission.slot.inventoryRevision === admission.inventoryRevision)
            return;
        throw new ConnectorGatewayError('CONNECTOR_TOOL_HANDLE_INVALID', 'Connector tool handle is stale for this Host inventory', 'not_dispatched', invocationId);
    }
    assertHostCallCurrent(admission, invocationId, outcome) {
        if (this.hostProcessSlots.get(admission.key) === admission.slot && !admission.slot.released) {
            return;
        }
        throw new ConnectorGatewayError('CONNECTOR_HOST_PROCESS_RELEASED', 'Host process was released before the Connector call could be published', outcome, invocationId);
    }
    releaseHostProcessSlot(slot) {
        slot.released = true;
        for (const call of slot.activeCalls)
            call.controller.abort();
        slot.toolHandles.clear();
        slot.inventoryRevision = undefined;
        slot.currentListToken = undefined;
    }
    assertEpochCurrent(expected, invocationId, outcome) {
        if (expected === this.principalEpoch && !this.closed)
            return;
        throw new ConnectorGatewayError('CONNECTOR_PRINCIPAL_CHANGED', 'Connector principal changed before the result could be published', outcome, invocationId);
    }
    assertOpen() {
        if (!this.closed)
            return;
        throw new ConnectorGatewayError('CONNECTOR_GATEWAY_CLOSED', 'Connector gateway is closed', 'not_dispatched');
    }
    async recordAdmission(event) {
        try {
            await this.options.audit?.record(event);
        }
        catch {
            throw new ConnectorGatewayError('CONNECTOR_AUDIT_UNAVAILABLE', 'Connector audit is unavailable', 'not_dispatched', event.invocationId);
        }
    }
    async recordTerminal(event) {
        const operation = this.observeTerminalAudit(event);
        this.terminalAudits.add(operation);
        try {
            await operation;
        }
        finally {
            this.terminalAudits.delete(operation);
        }
    }
    async observeTerminalAudit(event) {
        try {
            await this.options.audit?.record(event);
        }
        catch (error) {
            this.options.onAuditFailure?.(error);
        }
    }
}
function captureAuthContext(value) {
    const accessToken = value?.accessToken?.trim();
    const realUserID = value?.realUserID?.trim();
    const credential = accessToken && realUserID ? Object.freeze({ accessToken, realUserID }) : undefined;
    if (value?.authState === 'pending' || (value?.authState === 'authenticated' && !credential)) {
        return { state: 'pending' };
    }
    if (value?.authState === 'logged_out' || !credential)
        return { state: 'logged_out' };
    return { state: 'authenticated', credential };
}
/** `undefined` admits every provider. */
function providerAllowlist(allowlist) {
    if (allowlist === 'all')
        return undefined;
    const providers = new Set();
    for (const provider of allowlist) {
        if (!CONNECTOR_PROVIDER.test(provider)) {
            throw new ConnectorGatewayError('CONNECTOR_PROVIDER_POLICY_INVALID', 'Connector provider policy is invalid', 'not_dispatched');
        }
        providers.add(provider);
    }
    return providers;
}
function combineSignals(...signals) {
    const present = signals.filter((signal) => signal !== undefined);
    return present.length === 1 ? present[0] : AbortSignal.any(present);
}
function throwIfAborted(signal, invocationId) {
    if (!signal?.aborted)
        return;
    throw new ConnectorGatewayError('REQUEST_ABORTED', 'Connector request was aborted', 'not_dispatched', invocationId);
}
function normalizeCallError(error, dispatched, invocationId) {
    if (error instanceof ConnectorGatewayError)
        return error;
    return new ConnectorGatewayError('CONNECTOR_CALL_FAILED', 'Connector call failed', dispatched ? 'unknown_after_dispatch' : 'not_dispatched', invocationId);
}
function auditTerminal(input) {
    return {
        phase: 'terminal',
        timestampMs: input.finishedAtMs,
        invocationId: input.invocationId,
        principalEpoch: input.grant.principalEpoch,
        inventoryRevision: input.grant.inventoryRevision,
        callerKind: input.callerKind,
        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
        ...(input.processGeneration ? { processGeneration: input.processGeneration } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        provider: input.grant.descriptor.provider,
        tool: input.grant.descriptor.providerToolName,
        outcome: input.outcome,
        ...(input.code ? { code: input.code } : {}),
        durationMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
    };
}
function assertCallerBinding(binding, caller) {
    if (caller.pluginId === binding.pluginId &&
        caller.processGeneration === binding.processGeneration) {
        return;
    }
    throw new ConnectorGatewayError('CONNECTOR_TOOL_HANDLE_INVALID', 'Connector tool handle is invalid for this caller', 'not_dispatched');
}
function invocationIdForCall(hostRequest) {
    if (!isBoundedInvocationId(hostRequest.clientRequestId)) {
        throw new ConnectorGatewayError('CONNECTOR_CLIENT_REQUEST_ID_INVALID', 'Connector client request id is invalid', 'not_dispatched');
    }
    return requireBoundedInvocationId(hostRequest.invocationId);
}
function requireBoundedInvocationId(invocationId) {
    if (!isBoundedInvocationId(invocationId)) {
        throw new ConnectorGatewayError('CONNECTOR_INVOCATION_ID_INVALID', 'Connector invocation id is invalid', 'not_dispatched');
    }
    return invocationId;
}
function isBoundedInvocationId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= CONNECTOR_INVOCATION_ID_MAX_BYTES);
}
function hostInventoryKey(caller) {
    return JSON.stringify([caller.pluginId, caller.processGeneration]);
}
function captureHostProcessCaller(caller) {
    return Object.freeze({
        kind: 'host-process',
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
    });
}
function connectorToolIdentity(descriptor) {
    return JSON.stringify([
        descriptor.provider,
        descriptor.providerToolName,
        descriptor.runtimeToolName,
    ]);
}
function hostProcessAuditFields(caller, clientRequestId) {
    return {
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        clientRequestId,
    };
}
async function drainWithin(pending, timeoutMs) {
    if (pending.length === 0 || timeoutMs <= 0)
        return;
    let timer;
    await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        }),
    ]);
    if (timer)
        clearTimeout(timer);
}
function remainingMs(deadlineMs) {
    return Math.max(0, deadlineMs - performance.now());
}
function deferredCompletion() {
    let resolve = () => undefined;
    const promise = new Promise((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
//# sourceMappingURL=gateway.js.map