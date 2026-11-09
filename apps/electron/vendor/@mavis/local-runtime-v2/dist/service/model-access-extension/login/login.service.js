import { randomUUID } from 'node:crypto';
import { errorCode as codeOf, extensionContext } from '../core/context.js';
import { displayAccountMasked } from '../credentials/credential-state.js';
import { captureLoginFlow, captureLoginRequest, captureLoginValues, captureLoginView, captureNextLoginView, captureOwnedLoginResult, ModelAccessLoginError, observeLoginResult, providerLoginErrorCode, } from './validation.js';
const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'failed']);
const SAFE_ERRORS = new Set([
    'login_invalid',
    'login_invalidated',
    'login_expired',
    'login_cancelled',
    'login_failed',
    'binding_conflict',
    'credential_invalid',
    'credential_state_invalid',
    'credential_schema_mismatch',
    'secret_store_unavailable',
    'secret_store_locked_or_denied',
    'secret_store_timeout',
    'secret_store_busy',
    'secret_missing',
    'secret_invalid',
    'storage_failed',
    'installation_missing',
    'service_closed',
    'operation_invalidated',
    'capability_disabled',
    'unsupported_capability',
    'provider_conflict',
]);
/** Owns runtime flows only. Extension I/O never holds the host's persistence lane. */
export class ModelAccessLoginService {
    host;
    operations = new Map();
    closed = false;
    timeoutMs;
    cleanupTimeoutMs;
    constructor(host, options = {}) {
        this.host = host;
        this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
        this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
        for (const value of [this.timeoutMs, this.cleanupTimeoutMs]) {
            if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 60_000)
                throw new ModelAccessLoginError('login_invalid');
        }
    }
    begin(input) {
        const captured = captureLoginRequest(input);
        return this.host.serial(async () => {
            if (this.closed)
                throw new ModelAccessLoginError('login_closed');
            this.prune();
            const controller = new AbortController();
            const admission = this.admit(captured, controller.signal);
            const createdAt = Date.now();
            const operation = {
                input: captured,
                admission,
                controller,
                version: this.host.bindings.version(captured.providerKey),
                status: {
                    flowId: randomUUID(),
                    providerKey: captured.providerKey,
                    state: 'starting',
                    createdAt,
                    expiresAt: createdAt + this.timeoutMs,
                    cleanup: 'not-started',
                },
                removeListener: () => { },
                beginSettled: false,
                observationSettled: true,
                resultSettled: true,
                submissionSettled: true,
                cleanupSettled: true,
            };
            this.operations.set(operation.status.flowId, operation);
            this.listen(operation);
            operation.worker = this.run(operation);
            return this.project(operation);
        });
    }
    status(flowId) {
        return this.host.serial(async () => this.project(this.get(flowId)));
    }
    cancel(flowId) {
        return this.host.serial(async () => {
            const operation = this.get(flowId);
            this.stop(operation, 'cancelled');
            return this.project(operation);
        });
    }
    async submit(flowId, values) {
        // Capture before waiting for any I/O; never retain these values in status or errors.
        const operation = this.get(flowId);
        const captured = captureLoginValues(operation.status.view, values);
        await this.host.serial(async () => {
            this.assertCurrent(operation);
            if (operation.status.state !== 'waiting' || !operation.flow?.submit)
                throw new ModelAccessLoginError('login_not_waiting');
            operation.status = { ...operation.status, state: 'submitting' };
            operation.submissionSettled = false;
            operation.submission = this.runSubmission(operation, captured);
        });
        // Submission may poll or hang. The caller gets a status, not an unbounded RPC.
        return this.status(flowId);
    }
    async close() {
        this.closed = true;
        for (const operation of this.operations.values())
            this.stop(operation, 'cancelled');
        await Promise.all([...this.operations.values()].map((operation) => operation.cleanup));
    }
    invalidateProvider(providerId, installationId) {
        for (const operation of this.operations.values()) {
            if (operation.input.providerId === providerId &&
                (installationId === undefined || operation.input.installationId === installationId))
                this.stop(operation, 'failed', 'login_invalidated');
        }
    }
    admit(input, signal) {
        const selected = this.host
            .registry()
            .providerOf(input.installationId, input.providerId)?.registration;
        if (selected?.installationId !== input.installationId)
            throw new ModelAccessLoginError('login_unavailable');
        const generation = this.host.registry().acquire(input.installationId);
        try {
            const registration = generation.registration;
            if (registration.installationId !== input.installationId)
                throw new ModelAccessLoginError('login_unavailable');
            const source = registration.manifest.sources.find((item) => item.id === input.sourceId);
            const method = source?.capabilities.login?.methods.find((item) => item.id === input.methodId);
            const handler = registration.extension.sources[input.sourceId]?.login?.[input.methodId];
            const provider = registration.manifest.providers.find((item) => item.id === input.providerId);
            if (!method || !handler || !provider)
                throw new ModelAccessLoginError('login_unavailable');
            // Every login method (a CLI view included) produces a host-stored direct-owned credential.
            if (!provider.credentialKinds.includes('direct-owned'))
                throw new ModelAccessLoginError('login_unavailable');
            if (input.signal?.aborted)
                throw new ModelAccessLoginError('login_cancelled');
            const lease = this.host.policy().acquire({
                installationId: input.installationId,
                sourceId: input.sourceId,
                capability: 'login',
                entryId: input.methodId,
                targets: [input.target],
                explicitUserAction: input.explicitUserAction,
                dependenciesReady: input.dependenciesReady,
                signal,
            }, generation);
            const operationGeneration = lease.generationLease?.retain();
            if (!operationGeneration)
                throw new ModelAccessLoginError('login_unavailable');
            generation.release();
            return {
                handler,
                kind: method.kind,
                credentialSchema: provider.credentialSchema,
                lease,
                generation: operationGeneration,
            };
        }
        catch (error) {
            generation.release();
            throw error;
        }
    }
    listen(operation) {
        const invalidated = () => this.stop(operation, 'failed', 'login_invalidated');
        const cancelled = () => this.stop(operation, 'cancelled');
        operation.admission.lease.signal.addEventListener('abort', invalidated, { once: true });
        operation.input.signal?.addEventListener('abort', cancelled, { once: true });
        operation.removeListener = () => {
            operation.admission.lease.signal.removeEventListener('abort', invalidated);
            operation.input.signal?.removeEventListener('abort', cancelled);
        };
        operation.timer = setTimeout(() => this.stop(operation, 'expired'), this.timeoutMs);
        operation.timer.unref();
    }
    async run(operation) {
        try {
            this.assertCurrent(operation);
            const { lease, handler, kind } = operation.admission;
            const returned = await handler.begin(extensionContext({
                directories: this.host.directories,
                profileId: lease.profileId,
                installationId: lease.installationId,
                generation: lease.generation,
                operationId: operation.status.flowId,
                signal: lease.signal,
                enabledTargets: lease.enabledTargets,
                policyRevision: lease.policyRevision,
                updateLoginView: (next) => this.updateView(operation, next),
            }), Object.freeze({
                providerKey: operation.input.providerKey,
                target: operation.input.target,
                providerId: operation.input.providerId,
            }));
            operation.observationSettled = false;
            operation.observation = this.observe(operation, returned);
            const flow = captureLoginFlow(returned);
            operation.flow = flow;
            operation.resultSettled = false;
            // Observe result immediately, including malformed/late views and cancelled begin calls.
            operation.worker = this.consume(operation, flow);
            try {
                this.assertCurrent(operation);
                const initial = captureLoginView(flow.view, kind);
                if (initial.kind === 'secret-form' && !flow.submit)
                    throw new ModelAccessLoginError('login_invalid');
                // A next step set during begin (updateLoginView) wins over the initial view.
                const view = operation.status.view ?? initial;
                operation.status = { ...operation.status, state: 'waiting', view };
                if (view.kind === 'device')
                    this.deviceDeadline(operation, view.expiresAt);
            }
            catch (error) {
                this.stop(operation, 'failed', this.errorCode(error, operation.input.providerId));
                this.cleanup(operation);
            }
        }
        catch (error) {
            this.fail(operation, error);
        }
        finally {
            operation.beginSettled = true;
            this.releaseGeneration(operation);
        }
    }
    /**
     * A waiting flow's next step (form after browser, device after form). Captured like an initial
     * view; a form needs `submit`. A stale or finished flow refuses it and the extension fails.
     */
    updateView(operation, next) {
        this.assertCurrent(operation);
        const state = operation.status.state;
        if (state !== 'waiting' && state !== 'submitting' && state !== 'starting')
            throw new ModelAccessLoginError('login_not_waiting');
        const view = captureNextLoginView(next);
        if (view.kind === 'secret-form' && !operation.flow?.submit)
            throw new ModelAccessLoginError('login_invalid');
        operation.status = {
            ...operation.status,
            state: state === 'starting' ? 'starting' : 'waiting',
            view,
        };
        if (view.kind === 'device')
            this.deviceDeadline(operation, view.expiresAt);
    }
    async observe(operation, returned) {
        try {
            await observeLoginResult(returned);
        }
        finally {
            operation.observationSettled = true;
            this.releaseGeneration(operation);
        }
    }
    async consume(operation, flow) {
        let payload;
        let committed = false;
        try {
            const result = await flow.result;
            payload = resultPayload(result);
            this.assertCurrent(operation);
            const owned = captureOwnedLoginResult(result, operation.input.providerId, operation.admission.credentialSchema);
            operation.status = { ...operation.status, state: 'committing', view: undefined };
            const accountMasked = displayAccountMasked(result);
            const binding = await this.host.bindings.replaceOwned({
                ...owned,
                ...(accountMasked ? { accountMasked } : {}),
                providerKey: operation.input.providerKey,
                providerId: operation.input.providerId,
                installationId: operation.input.installationId,
                credentialSchema: operation.admission.credentialSchema,
                signal: operation.admission.lease.signal,
                startedAt: operation.version,
                login: { sourceId: operation.input.sourceId },
            });
            committed = true;
            // Committed: the credential exists even if the user cancelled during the write.
            this.completed(operation, binding);
        }
        catch (error) {
            // A result the host did not keep (late, cancelled, invalid or failed to commit): let the
            // extension remove what it created for it (a CLI home, a process).
            if (!committed && payload !== undefined)
                await this.forgetLate(operation, payload);
            this.fail(operation, error);
        }
        finally {
            operation.resultSettled = true;
            this.releaseGeneration(operation);
        }
    }
    async forgetLate(operation, payload) {
        try {
            await this.host.forgetLate({
                generation: operation.admission.generation,
                installationId: operation.input.installationId,
                providerId: operation.input.providerId,
                providerKey: operation.input.providerKey,
                payload,
            });
        }
        catch {
            /* The host logs; a discarded result never fails differently because of cleanup. */
        }
    }
    completed(operation, binding) {
        const { providerKey, installationId, providerId, identityRevision } = binding;
        operation.status = {
            ...operation.status,
            state: 'completed',
            errorCode: undefined,
            view: undefined,
            binding: { providerKey, installationId, providerId, kind: 'direct-owned', identityRevision },
        };
        this.finish(operation);
    }
    assertCurrent(operation) {
        if (this.closed || operation.stopReason || TERMINAL.has(operation.status.state))
            throw new ModelAccessLoginError('login_invalidated');
        if (Date.now() >= operation.status.expiresAt)
            throw new ModelAccessLoginError('login_expired');
        operation.admission.lease.assertCurrent();
        if (this.host.bindings.version(operation.input.providerKey) !== operation.version)
            throw new ModelAccessLoginError('binding_conflict');
        if (this.host
            .registry()
            .providerOf(operation.input.installationId, operation.input.providerId)?.registration
            .installationId !== operation.input.installationId)
            throw new ModelAccessLoginError('login_invalidated');
    }
    stop(operation, reason, code) {
        if (TERMINAL.has(operation.status.state) || operation.stopReason)
            return;
        operation.stopReason = reason;
        const committing = operation.status.state === 'committing';
        operation.status = {
            ...operation.status,
            state: committing ? 'cancelling' : reason,
            view: undefined,
            errorCode: code,
        };
        operation.removeListener();
        operation.controller.abort();
        this.finish(operation);
    }
    fail(operation, error) {
        if (operation.status.state === 'completed')
            return;
        operation.status = {
            ...operation.status,
            state: operation.stopReason ?? 'failed',
            view: undefined,
            errorCode: operation.status.errorCode ?? this.errorCode(error, operation.input.providerId),
        };
        this.finish(operation);
    }
    finish(operation) {
        if (operation.timer)
            clearTimeout(operation.timer);
        operation.removeListener();
        operation.controller.abort();
        operation.admission.lease.release();
        this.cleanup(operation);
        this.releaseGeneration(operation);
    }
    cleanup(operation) {
        if (!operation.flow || operation.cleanup)
            return;
        const flow = operation.flow;
        operation.flow = undefined;
        operation.status = { ...operation.status, cleanup: 'running' };
        operation.cleanupSettled = false;
        operation.cleanup = this.clean(operation, flow);
    }
    async clean(operation, flow) {
        let timer;
        try {
            const outcome = await Promise.race([
                (async () => {
                    try {
                        await flow.cancel();
                        return 'completed';
                    }
                    finally {
                        operation.cleanupSettled = true;
                        this.releaseGeneration(operation);
                    }
                })(),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve('timed-out'), this.cleanupTimeoutMs);
                }),
            ]);
            operation.status = { ...operation.status, cleanup: outcome };
        }
        catch {
            operation.status = { ...operation.status, cleanup: 'failed' };
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async runSubmission(operation, values) {
        try {
            this.assertCurrent(operation);
            await operation.flow.submit(values);
            // A next step set during submit (updateLoginView) already replaced the view.
            if (operation.status.state === 'submitting')
                operation.status = { ...operation.status, state: 'waiting' };
        }
        catch (error) {
            this.stop(operation, 'failed', this.errorCode(error, operation.input.providerId));
        }
        finally {
            operation.submissionSettled = true;
            this.releaseGeneration(operation);
        }
    }
    deviceDeadline(operation, expiresAt) {
        const deadline = Math.min(expiresAt, operation.status.expiresAt);
        operation.status = { ...operation.status, expiresAt: deadline };
        if (operation.timer)
            clearTimeout(operation.timer);
        operation.timer = setTimeout(() => this.stop(operation, 'expired'), Math.max(0, deadline - Date.now()));
        operation.timer.unref();
    }
    errorCode(error, providerId) {
        // Extension-controlled messages never escape; only the provider's own `<id>_<reason>` codes.
        const provided = providerId ? providerLoginErrorCode(error, providerId) : undefined;
        if (provided)
            return provided;
        // Judged by code string only: a trusted extension's errors are not host class instances.
        const code = codeOf(error);
        return code && SAFE_ERRORS.has(code) ? code : 'login_failed';
    }
    project(operation) {
        return structuredClone(operation.status);
    }
    get(flowId) {
        const operation = this.operations.get(flowId);
        if (!operation)
            throw new ModelAccessLoginError('login_missing');
        return operation;
    }
    prune() {
        for (const [id, operation] of this.operations) {
            if (this.operations.size < 128)
                break;
            const settled = [
                operation.beginSettled,
                operation.observationSettled,
                operation.resultSettled,
                operation.submissionSettled,
                operation.cleanupSettled,
            ].every(Boolean);
            if (TERMINAL.has(operation.status.state) && settled)
                this.operations.delete(id);
        }
        if (this.operations.size >= 128)
            throw new ModelAccessLoginError('login_busy');
    }
    releaseGeneration(operation) {
        if (TERMINAL.has(operation.status.state) &&
            operation.beginSettled &&
            operation.observationSettled &&
            operation.resultSettled &&
            operation.submissionSettled &&
            operation.cleanupSettled)
            operation.admission.generation.release();
    }
}
/** The vendor payload of a login result, for forget; undefined when there is none. */
function resultPayload(result) {
    if (!result || typeof result !== 'object')
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(result, 'payload');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
//# sourceMappingURL=login.service.js.map