import { randomUUID } from 'node:crypto';
import { ModelAccessPolicyError } from '../core/policy.js';
import { ModelAccessRequestError } from '../request/validation.js';
import { errorCode, extensionContext } from '../core/context.js';
import { displayAccountMasked, ModelAccessCredentialError, } from '../credentials/credential-state.js';
import { ModelAccessPackageError } from '../errors.js';
import { captureBorrowCredential, captureBorrowDiscoveries, captureBorrowDiscovery, captureBorrowSelection, captureBorrowResolution, captureBorrowRenewal, ModelAccessBorrowError, } from './validation.js';
import { borrowFingerprint, ModelAccessBorrowRenewalService } from './renewal.service.js';
/** Calls trusted extensions outside the commit lane; deadlines stop publication, not native code. */
export class ModelAccessBorrowService {
    host;
    timeoutMs;
    operations = new Set();
    pending = new Set();
    closed = false;
    issued = new WeakSet();
    renewals;
    /** Per key: read sequence, and the start of the newest read that succeeded (runtime only). */
    readSequence = 0;
    lastGoodRead = new Map();
    constructor(host, timeoutMs = 30_000) {
        this.host = host;
        this.timeoutMs = timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
            throw new ModelAccessBorrowError('borrow_invalid');
        this.renewals = new ModelAccessBorrowRenewalService(host, timeoutMs);
    }
    discover(input) {
        const captured = captureBorrowDiscovery(input);
        return this.execute(captured.signal, async (operation) => {
            const admission = await this.host.serial(async () => this.admit(captured.sourceRef, operation.signal));
            const unlisten = this.listen(admission, operation);
            try {
                admission.lease.assertCurrent();
                const result = await admission.handler.discover(this.context(admission));
                return await this.host.serial(async () => {
                    admission.lease.assertCurrent();
                    if (!this.host.policy().subscriptionsEnabled())
                        throw new ModelAccessPolicyError('subscription_disabled');
                    const discoveries = captureBorrowDiscoveries(result, captured.sourceRef);
                    for (const item of discoveries)
                        this.provider(item.providerId, captured.sourceRef.installationId);
                    return discoveries;
                });
            }
            finally {
                unlisten();
                admission.lease.release();
                admission.generation?.release();
            }
        });
    }
    useCurrent(input) {
        const captured = captureBorrowSelection(input);
        return this.execute(captured.signal, async (operation) => {
            const admission = await this.host.serial(async () => this.admitSelection(captured, operation.signal));
            const unlisten = this.listen(admission, operation);
            try {
                this.assertSelection(captured, admission);
                const result = await admission.handler.resolve(this.context(admission), captured.sourceRef);
                this.assertSelection(captured, admission);
                const credential = captureBorrowCredential(result, captured.providerId);
                const accountMasked = displayAccountMasked(result);
                this.assertSelection(captured, admission);
                // Past this point await the durable outcome: cancellation cannot undo a rename.
                operation.committing = true;
                return await this.host.bindings.replaceBorrowed({
                    providerKey: captured.providerKey,
                    providerId: captured.providerId,
                    installationId: captured.sourceRef.installationId,
                    credentialSchema: admission.credentialSchema,
                    identity: credential.identity,
                    ...(accountMasked ? { accountMasked } : {}),
                    sourceRef: captured.sourceRef,
                    signal: admission.lease.signal,
                    startedAt: admission.version,
                });
            }
            finally {
                unlisten();
                admission.lease.release();
                admission.generation?.release();
            }
        });
    }
    resolveCurrent(input, generation) {
        const captured = captureBorrowResolution(input);
        if (!captured.dependenciesReady)
            return Promise.reject(new ModelAccessPolicyError('dependency_unavailable'));
        return this.execute(captured.signal, async (operation) => {
            const lease = await this.host.bindings.readBorrowed({
                providerKey: captured.providerKey,
                signal: operation.signal,
                generationLease: generation,
            });
            const source = lease.binding.sourceRef;
            const retained = lease.generationLease?.retain();
            const handler = (retained?.registration ?? this.host.registry().get(source.installationId))
                ?.extension.sources[source.sourceId]?.subscriptionBorrow?.[source.variant];
            if (!handler) {
                retained?.release();
                lease.release();
                throw new ModelAccessBorrowError('borrow_unavailable');
            }
            const admission = { lease, handler, operationId: randomUUID() };
            const unlisten = this.listen(admission, operation);
            const key = lease.binding.providerKey;
            const started = ++this.readSequence;
            let invalidateOnFailure = true;
            try {
                lease.assertCurrent();
                const context = this.context(admission);
                const result = await handler.resolve(context, source);
                lease.assertCurrent();
                const credential = captureBorrowCredential(result, lease.binding.providerId, true);
                // A different account now: the record follows it and calls on the old one are aborted.
                const binding = await this.host.bindings.observeBorrowed(lease, credential.identity);
                if (binding.identityHash !== lease.binding.identityHash) {
                    invalidateOnFailure = false;
                    throw new ModelAccessPolicyError('operation_invalidated');
                }
                lease.assertCurrent();
                this.lastGoodRead.set(key, Math.max(this.lastGoodRead.get(key) ?? 0, started));
                invalidateOnFailure = false;
                if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())
                    return await this.renewExpired(lease, credential, context);
                return this.issue({
                    binding,
                    credential,
                    fingerprint: borrowFingerprint(credential),
                    lease,
                    context,
                });
            }
            catch (error) {
                // Stop listening first: releasing the lease must not turn this error into a cancellation.
                unlisten();
                if (invalidateOnFailure)
                    await this.invalidateAfterFailedRead(lease, started);
                lease.release();
                throw error;
            }
            finally {
                unlisten();
                retained?.release();
            }
        });
    }
    /** An invalid read of the source aborts calls on the key, unless a newer read succeeded. */
    async invalidateAfterFailedRead(lease, started) {
        if (this.closed || (this.lastGoodRead.get(lease.binding.providerKey) ?? 0) >= started)
            return;
        try {
            await this.host.bindings.invalidateBorrowed(lease);
        }
        catch {
            /* Closed admission already invalidates the policy lease. */
        }
    }
    async renewExpired(lease, credential, context) {
        const result = await this.renewals.run({
            binding: lease.binding,
            previous: credential,
            previousFingerprint: borrowFingerprint(credential),
            mode: 'normal',
            signal: lease.signal,
            generation: lease.generationLease,
        });
        lease.assertCurrent();
        if (result.credential.expiresAt !== undefined && result.credential.expiresAt <= Date.now())
            throw new ModelAccessBorrowError('borrow_expired');
        return this.issue({
            binding: result.binding,
            credential: result.credential,
            fingerprint: result.fingerprint,
            lease,
            context,
        });
    }
    renewCurrent(input) {
        const captured = captureBorrowRenewal(input, this.issued);
        if (!captured.dependenciesReady)
            return Promise.reject(new ModelAccessPolicyError('dependency_unavailable'));
        const callerSignal = AbortSignal.any([captured.signal, captured.previous.lease.signal]);
        return this.execute(callerSignal, async (operation) => {
            captured.previous.lease.assertCurrent();
            // The handed-out lease outlives `previous`: only the caller's own signal (and policy)
            // ends it; the previous lease and the deadline bound this operation, not the result.
            const lease = await this.host.bindings.readBorrowed({
                providerKey: captured.providerKey,
                signal: captured.signal,
                generationLease: captured.previous.lease.generationLease,
            });
            const retained = lease.generationLease?.retain();
            const handler = (retained?.registration ?? this.host.registry().get(lease.installationId))
                ?.extension.sources[lease.binding.sourceRef.sourceId]?.subscriptionBorrow?.[lease.binding.sourceRef.variant];
            if (!handler) {
                retained?.release();
                lease.release();
                throw new ModelAccessBorrowError('borrow_unavailable');
            }
            const admission = { lease, handler, operationId: randomUUID() };
            const unlisten = this.listen(admission, operation);
            try {
                lease.assertCurrent();
                const result = await this.renewals.run({
                    binding: lease.binding,
                    previous: captured.previous.credential,
                    previousFingerprint: captured.previous.fingerprint,
                    mode: captured.mode,
                    signal: lease.signal,
                    generation: retained,
                });
                lease.assertCurrent();
                if (result.credential.expiresAt !== undefined && result.credential.expiresAt <= Date.now())
                    throw new ModelAccessBorrowError('borrow_expired');
                return this.issue({
                    binding: result.binding,
                    credential: result.credential,
                    fingerprint: result.fingerprint,
                    lease,
                    context: this.context(admission),
                });
            }
            catch (error) {
                unlisten();
                lease.release();
                throw error;
            }
            finally {
                unlisten();
                retained?.release();
            }
        });
    }
    issue(result) {
        const issued = Object.freeze(result);
        this.issued.add(issued);
        return issued;
    }
    close() {
        this.closed = true;
        this.renewals.close();
        for (const operation of this.operations)
            operation.abort();
    }
    /** Closing admission is bounded; profile ownership waits for actual trusted handler settlement. */
    async settled() {
        await Promise.allSettled([...this.pending]);
        await this.renewals.settled();
    }
    provider(providerId, installationId) {
        const registration = this.host.registry().providerOf(installationId, providerId)?.registration;
        if (registration?.installationId !== installationId)
            throw new ModelAccessBorrowError('borrow_unavailable');
        const provider = registration.manifest.providers.find((item) => item.id === providerId);
        if (!provider?.credentialKinds.includes('borrowed-current'))
            throw new ModelAccessBorrowError('borrow_unavailable');
        return provider;
    }
    admit(source, signal) {
        if (this.closed)
            throw new ModelAccessBorrowError('borrow_closed');
        const generation = this.host.registry().acquire(source.installationId);
        try {
            const handler = generation.registration.extension.sources[source.sourceId]?.subscriptionBorrow?.[source.variant];
            if (!handler)
                throw new ModelAccessBorrowError('borrow_unavailable');
            const lease = this.host.policy().acquire({
                installationId: source.installationId,
                sourceId: source.sourceId,
                capability: 'subscriptionBorrow',
                entryId: source.variant,
                targets: [source.target],
                signal,
            }, generation);
            return { handler, lease, operationId: randomUUID(), generation };
        }
        catch (error) {
            generation.release();
            throw error;
        }
    }
    admitSelection(input, signal) {
        if (!input.explicitUserAction)
            throw new ModelAccessPolicyError('explicit_action_required');
        if (!input.dependenciesReady)
            throw new ModelAccessPolicyError('dependency_unavailable');
        const provider = this.provider(input.providerId, input.sourceRef.installationId);
        return {
            ...this.admit(input.sourceRef, signal),
            version: this.host.bindings.version(input.providerKey),
            credentialSchema: provider.credentialSchema,
        };
    }
    assertSelection(input, admission) {
        admission.lease.assertCurrent();
        if (!this.host.policy().subscriptionsEnabled())
            throw new ModelAccessPolicyError('subscription_disabled');
        // Borrow leases stay valid for running requests; a new selection re-checks remote rules.
        const remote = this.host.policy().remoteBlock('subscriptionBorrow', input.sourceRef.sourceId, { entryId: input.sourceRef.variant, target: input.sourceRef.target }, input.sourceRef.installationId);
        if (remote)
            throw new ModelAccessPolicyError('remote_disabled', remote.reason);
        if (this.closed)
            throw new ModelAccessBorrowError('borrow_closed');
        this.provider(input.providerId, input.sourceRef.installationId);
        if (this.host.bindings.version(input.providerKey) !== admission.version)
            throw new ModelAccessCredentialError('binding_conflict');
    }
    context(admission) {
        const { lease, operationId } = admission;
        return extensionContext({
            directories: this.host.directories,
            profileId: lease.profileId,
            installationId: lease.installationId,
            generation: lease.generation,
            operationId,
            signal: lease.signal,
            enabledTargets: lease.enabledTargets,
            policyRevision: lease.policyRevision,
        });
    }
    listen(admission, operation) {
        const abort = () => operation.controller.abort();
        admission.lease.signal.addEventListener('abort', abort, { once: true });
        if (admission.lease.signal.aborted)
            abort();
        return () => admission.lease.signal.removeEventListener('abort', abort);
    }
    execute(signal, run) {
        if (this.closed)
            return Promise.reject(new ModelAccessBorrowError('borrow_closed'));
        if (this.operations.size >= 128)
            return Promise.reject(new ModelAccessBorrowError('borrow_limit'));
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref();
        this.operations.add(controller);
        const operation = { controller, signal: combined, committing: false };
        const work = (async () => {
            try {
                return await run(operation);
            }
            catch (error) {
                throw this.safeError(error);
            }
            finally {
                clearTimeout(timer);
                this.operations.delete(controller);
            }
        })();
        this.pending.add(work);
        return this.cancellable(this.track(work), operation);
    }
    async track(work) {
        try {
            return await work;
        }
        finally {
            this.pending.delete(work);
        }
    }
    async cancellable(work, operation) {
        const { signal } = operation;
        let rejectAbort;
        const stopped = new Promise((_resolve, reject) => {
            rejectAbort = reject;
        });
        const aborted = () => {
            if (!operation.committing)
                rejectAbort(new ModelAccessPolicyError('operation_invalidated'));
        };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted)
            aborted();
        try {
            return await Promise.race([work, stopped]);
        }
        finally {
            signal.removeEventListener('abort', aborted);
        }
    }
    safeError(error) {
        if (error instanceof ModelAccessPolicyError ||
            error instanceof ModelAccessCredentialError ||
            error instanceof ModelAccessPackageError ||
            error instanceof ModelAccessBorrowError ||
            error instanceof ModelAccessRequestError)
            return error;
        // A trusted extension's own error: only its code decides, never its message or class.
        return new ModelAccessBorrowError(errorCode(error) === 'borrow_expired' ? 'borrow_expired' : 'borrow_failed');
    }
}
//# sourceMappingURL=borrow.service.js.map