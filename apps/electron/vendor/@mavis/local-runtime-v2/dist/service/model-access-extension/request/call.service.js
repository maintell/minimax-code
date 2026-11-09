import { ModelAccessPolicyError } from '../core/policy.js';
import { accessBinding, extensionContext } from '../core/context.js';
import { identityHash } from '../credentials/credential-state.js';
import { captureBoundTransport, ModelAccessRequestError } from './validation.js';
import { captureRequestModel, captureRequestModels, captureRequestUsage, } from './catalog-validation.js';
import { ModelAccessTransportLifetime } from './transport-lifetime.js';
import { providerLimitsOf } from './admission.js';
/** One logical call; attempts are serialized and share the original binding and subject. */
export class ModelAccessCallService {
    options;
    binding;
    signal;
    controller = new AbortController();
    pending = new Set();
    classificationPending = new Set();
    classifications = new WeakMap();
    attempts = new Set();
    busy = false;
    /** An attempt waiting for its account's slot / minute (outside execute's own timer). */
    admitting = false;
    cleanupFailed = false;
    closing;
    cancelling;
    abort = () => this.cancel();
    borrowed;
    /** The owned credential the latest attempt used (forced-renewal dedupe by write count). */
    lastOwned;
    recovery;
    generation;
    cancel() {
        this.cancelling ??= this.cancelAndObserve();
    }
    async cancelAndObserve() {
        try {
            await this.close();
        }
        catch {
            /* Explicit close still returns the retained cleanup outcome. */
        }
    }
    constructor(options) {
        this.options = options;
        this.binding = options.lease.binding;
        this.generation = options.host
            .registry()
            .acquire(this.binding.installationId, options.lease.generationLease);
        this.signal = AbortSignal.any([
            options.lease.signal,
            this.controller.signal,
            this.generation.signal,
        ]);
        this.signal.addEventListener('abort', this.abort, { once: true });
    }
    assertCurrent() {
        if (this.cleanupFailed)
            throw new ModelAccessRequestError('request_cleanup_failed');
        if (this.signal.aborted)
            throw new ModelAccessRequestError('request_closed');
        this.options.lease.assertCurrent();
        this.generation.assertCurrent();
    }
    provider() {
        this.assertCurrent();
        const handler = this.generation.registration.extension.providers[this.binding.providerId];
        if (!handler)
            throw new ModelAccessRequestError('request_unavailable');
        return handler;
    }
    context() {
        const registration = this.generation.registration;
        return extensionContext({
            directories: this.options.host.directories,
            profileId: this.options.host.profileId,
            installationId: this.binding.installationId,
            generation: registration.generation,
            signal: this.signal,
            ...(this.options.sessionKey ? { sessionKey: this.options.sessionKey } : {}),
        });
    }
    async resolve() {
        this.assertCurrent();
        if (this.binding.kind === 'borrowed-current') {
            const result = await this.options.host.borrow.resolveCurrent({
                providerKey: this.binding.providerKey,
                signal: this.signal,
                dependenciesReady: true,
            }, this.generation);
            try {
                this.assertCurrent();
                if (identityHash(result.credential.identity) !== this.binding.identityHash)
                    throw new ModelAccessRequestError('request_identity_changed');
                result.lease.assertCurrent();
                this.borrowed?.lease.release();
                this.borrowed = result;
                // The call retains the issued handle for recovery after attempt transport cleanup.
                // Ordinary attempts still resolve current anew; replacing this handle releases it.
                return {
                    ...result,
                    assertCurrent: () => {
                        this.assertCredential(result.credential);
                        result.lease.assertCurrent();
                    },
                    release: () => { },
                };
            }
            catch (error) {
                result.lease.release();
                throw error;
            }
        }
        if (this.binding.kind === 'public')
            return this.resolvePublic();
        const owned = await this.options.resolveOwned(this.binding, this.signal, () => this.assertCurrent(), this.generation);
        this.assertCurrent();
        this.lastOwned = owned;
        return {
            binding: owned.binding,
            credential: owned.credential,
            context: this.context(),
            assertCurrent: () => this.assertCredential(owned.credential),
            release: () => { },
        };
    }
    resolvePublic() {
        this.provider();
        const credential = Object.freeze({
            identity: Object.freeze({ public: true }),
            payload: null,
        });
        return {
            binding: this.binding,
            context: this.context(),
            credential,
            assertCurrent: () => this.assertCurrent(),
            release: () => { },
        };
    }
    async release(resolved) {
        try {
            await resolved.release();
        }
        catch {
            this.cleanupFailed = true;
            throw new ModelAccessRequestError('request_cleanup_failed');
        }
    }
    assertCredential(credential) {
        this.assertCurrent();
        if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())
            throw new ModelAccessRequestError('request_expired');
    }
    async classifyFailure(failure) {
        try {
            this.assertCurrent();
            if (isHostFailure(failure.thrown))
                return { kind: 'terminal', errorKind: 'unknown' };
            const decision = classifyProviderFailure(await this.classifyProviderError(failure));
            this.assertCurrent();
            if (decision.kind === 'recover' && !this.canRecover())
                return { kind: 'terminal', errorKind: 'auth' };
            // A kept-alive connection a proxy or the vendor's front dropped while idle fails before a
            // byte of a reply: asked again at once, on a new connection, not after a backoff.
            if (decision.kind === 'retry' && decision.retryReason === 'network' && droppedIdle(failure))
                return { ...decision, retryAfterMs: 0 };
            return decision;
        }
        catch {
            return { kind: 'terminal', errorKind: 'unknown' };
        }
    }
    async classifyProvider(failure) {
        try {
            this.assertCurrent();
            if (isHostFailure(failure.thrown))
                return { host: true };
            const classified = await this.classifyProviderError(failure);
            this.assertCurrent();
            return { host: false, classified };
        }
        catch {
            return { host: true };
        }
    }
    /** One logical failure shares one child RPC; the WeakMap bounds lifetime to the failure object. */
    classifyProviderError(failure) {
        const key = failure;
        const existing = this.classifications.get(key);
        if (existing)
            return existing;
        const work = this.trackClassification((async () => {
            this.assertCurrent();
            const handler = this.provider().classifyError;
            const classified = await handler(failure.thrown ?? failure.final ?? failure.response, {
                signal: this.signal,
            });
            if (!isClassifiedAccessError(classified))
                throw new Error('request_classification_invalid');
            this.assertCurrent();
            return classified;
        })());
        this.classifications.set(key, work);
        return work;
    }
    trackClassification(work) {
        this.classificationPending.add(work);
        return this.observeClassification(work);
    }
    async observeClassification(work) {
        try {
            return await work;
        }
        finally {
            this.classificationPending.delete(work);
        }
    }
    canRecover() {
        if (this.binding.kind === 'direct-owned')
            return !!this.lastOwned && !!this.provider().forceRenewOwned;
        if (this.binding.kind !== 'borrowed-current' || !this.borrowed)
            return false;
        const source = this.binding.sourceRef;
        const registration = this.generation.registration;
        return (!!registration &&
            !!registration.extension.sources[source.sourceId]?.subscriptionBorrow?.[source.variant]
                ?.forceRenew);
    }
    recover(input) {
        this.assertRecoveryInput(input);
        if (this.recovery || this.busy || this.attempts.size)
            throw new ModelAccessRequestError('request_busy');
        if (!this.canRecover())
            throw new ModelAccessRequestError('request_unavailable');
        // execute owns admission, actual work and drain even when a caller stops waiting.
        return this.execute(async () => {
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(), Math.min(input.deadlineAt - Date.now(), this.options.timeoutMs));
            timer.unref();
            const captured = {
                signal: AbortSignal.any([input.signal, this.signal, deadline.signal]),
                deadlineAt: input.deadlineAt,
            };
            const work = this.recoverNow(captured);
            this.recovery = work;
            try {
                await work;
            }
            finally {
                clearTimeout(timer);
                this.recovery = undefined;
            }
        });
    }
    assertRecoveryInput(input) {
        this.assertCurrent();
        if (input.signal.aborted ||
            !Number.isSafeInteger(input.deadlineAt) ||
            Date.now() >= input.deadlineAt)
            throw new ModelAccessRequestError('request_closed');
    }
    async recoverNow(input) {
        this.assertRecoveryInput(input);
        if (this.binding.kind === 'direct-owned' && this.lastOwned) {
            const rejected = this.lastOwned;
            await this.options.forceOwned(rejected.binding, rejected.writes, input.signal, {
                assertCurrent: () => this.assertRecoveryInput(input),
                generation: this.generation,
            });
            this.assertRecoveryInput(input);
            return;
        }
        if (this.binding.kind !== 'borrowed-current' || !this.borrowed)
            throw new ModelAccessRequestError('request_unavailable');
        const previous = this.borrowed;
        const renewed = await this.options.host.borrow.renewCurrent({
            providerKey: this.binding.providerKey,
            signal: input.signal,
            dependenciesReady: true,
            previous,
            mode: 'forced',
        });
        let retained = false;
        try {
            this.assertRecoveryInput(input);
            renewed.lease.assertCurrent();
            if (identityHash(renewed.credential.identity) !== this.binding.identityHash)
                throw new ModelAccessRequestError('request_identity_changed');
            previous.lease.release();
            this.borrowed = renewed;
            retained = true;
        }
        finally {
            if (!retained)
                renewed.lease.release();
        }
    }
    prepare(model) {
        const captured = captureRequestModel(model);
        const admission = this.options.admission;
        if (!admission)
            return this.prepareNow(captured);
        // Same synchronous refusal as execute() for a call that is no longer current.
        this.assertCurrent();
        if (this.binding.kind !== 'public' && this.options.host.subscriptionsEnabled?.() === false)
            return Promise.reject(new ModelAccessPolicyError('subscription_disabled'));
        if (this.admitting || this.busy || this.attempts.size)
            return Promise.reject(new ModelAccessRequestError('request_busy'));
        return this.admitThenPrepare(captured);
    }
    /**
     * The account's concurrency slot and room in its minute are taken before the attempt's own
     * timer starts: a queued request waits as long as the call's signal (cancellation, the
     * logical call's deadline) allows, and a slot is held until the attempt closes.
     */
    async admitThenPrepare(captured) {
        this.admitting = true;
        let ticket;
        try {
            const limits = providerLimitsOf(this.generation.registration.extension.providers[this.binding.providerId]);
            ticket = await this.options.admission.admit(this.binding.providerKey, limits, this.signal);
        }
        finally {
            this.admitting = false;
        }
        try {
            this.assertCurrent();
            return await this.prepareNow(captured, ticket);
        }
        catch (error) {
            ticket.release();
            throw error;
        }
    }
    prepareNow(captured, ticket) {
        return this.execute(async () => {
            const resolved = await this.resolve();
            let raw;
            let transferred = false;
            try {
                resolved.assertCurrent();
                raw = await this.provider().bindTransport(resolved.context, resolved.credential, captured);
                resolved.assertCurrent();
                if (this.binding.kind !== 'public' && this.options.host.subscriptionsEnabled?.() === false)
                    throw new ModelAccessPolicyError('subscription_disabled');
                const transport = captureBoundTransport(raw);
                const lifetime = new ModelAccessTransportLifetime(transport, AbortSignal.any([this.signal, resolved.context.signal]), () => resolved.assertCurrent());
                let closing;
                const attempt = Object.freeze({
                    binding: resolved.binding,
                    transport: lifetime.transport,
                    signal: lifetime.signal,
                    assertCurrent: () => lifetime.assertCurrent(),
                    close: () => {
                        closing ??= (async () => {
                            resolved.cancel?.();
                            try {
                                await lifetime.close();
                            }
                            catch {
                                this.cleanupFailed = true;
                                throw new ModelAccessRequestError('request_cleanup_failed');
                            }
                            finally {
                                try {
                                    await this.release(resolved);
                                }
                                finally {
                                    this.attempts.delete(attempt);
                                    ticket?.release();
                                }
                            }
                        })();
                        return closing;
                    },
                });
                this.attempts.add(attempt);
                transferred = true;
                return attempt;
            }
            finally {
                if (!transferred) {
                    resolved.cancel?.();
                    try {
                        await raw?.dispose?.();
                    }
                    catch {
                        this.cleanupFailed = true;
                        throw new ModelAccessRequestError('request_cleanup_failed');
                    }
                    finally {
                        await this.release(resolved);
                    }
                }
            }
        });
    }
    models() {
        return this.execute(async () => {
            const resolved = await this.resolve();
            try {
                const models = await this.provider().models(resolved.context, accessBinding(resolved.binding), resolved.credential);
                resolved.assertCurrent();
                return captureRequestModels(models);
            }
            finally {
                await this.release(resolved);
            }
        });
    }
    usage() {
        return this.execute(async () => {
            const resolved = await this.resolve();
            try {
                const provider = this.provider();
                const usage = provider.usage
                    ? await provider.usage(resolved.context, accessBinding(resolved.binding), resolved.credential)
                    : { status: 'unsupported', queriedAt: Date.now() };
                resolved.assertCurrent();
                return captureRequestUsage(usage);
            }
            finally {
                await this.release(resolved);
            }
        });
    }
    execute(run) {
        this.assertCurrent();
        if (this.binding.kind !== 'public' && this.options.host.subscriptionsEnabled?.() === false)
            return Promise.reject(new ModelAccessPolicyError('subscription_disabled'));
        if (this.busy || this.attempts.size)
            return Promise.reject(new ModelAccessRequestError('request_busy'));
        this.busy = true;
        const timer = setTimeout(() => this.controller.abort(), this.options.timeoutMs);
        timer.unref();
        const work = (async () => {
            try {
                const result = await run();
                this.assertCurrent();
                return result;
            }
            catch (error) {
                if (error instanceof ModelAccessRequestError || error instanceof ModelAccessPolicyError)
                    throw error;
                throw new ModelAccessRequestError('request_failed');
            }
            finally {
                clearTimeout(timer);
                this.busy = false;
            }
        })();
        this.pending.add(work);
        return this.wait(work);
    }
    async wait(work) {
        let abort;
        const stopped = new Promise((_resolve, reject) => {
            abort = () => reject(new ModelAccessRequestError('request_closed'));
        });
        this.signal.addEventListener('abort', abort, { once: true });
        if (this.signal.aborted)
            abort();
        const tracked = (async () => {
            try {
                return await work;
            }
            finally {
                this.pending.delete(work);
            }
        })();
        try {
            return await Promise.race([tracked, stopped]);
        }
        finally {
            this.signal.removeEventListener('abort', abort);
        }
    }
    close() {
        if (this.closing)
            return this.closing;
        this.signal.removeEventListener('abort', this.abort);
        this.controller.abort();
        this.closing = this.drain();
        return this.closing;
    }
    async drain() {
        try {
            await Promise.allSettled([...this.pending, ...this.classificationPending]);
            const outcomes = await Promise.allSettled([...this.attempts].map((attempt) => attempt.close()));
            if (this.borrowed) {
                this.borrowed.lease.release();
                this.borrowed = undefined;
            }
            if (this.cleanupFailed || outcomes.some((outcome) => outcome.status === 'rejected'))
                throw new ModelAccessRequestError('request_cleanup_failed');
        }
        finally {
            this.options.lease.release();
            this.generation.release();
            this.options.finished();
        }
    }
}
/** Host error classes (admission, identity, storage, borrow): never an account problem. */
const HOST_ERROR_NAMES = new Set([
    'ModelAccessRequestError',
    'ModelAccessPolicyError',
    'ModelAccessCredentialError',
    'ModelAccessBorrowError',
]);
function isHostFailure(error) {
    // Host-thrown errors only: an extension's own errors are judged by the provider classifier.
    return (error instanceof Error &&
        ((error.hostFailure === true &&
            typeof error.code === 'string') ||
            (HOST_ERROR_NAMES.has(error.name) &&
                typeof error.code === 'string')));
}
function isClassifiedAccessError(value) {
    return (!!value &&
        typeof value === 'object' &&
        typeof value.category === 'string' &&
        typeof value.code === 'string' &&
        typeof value.retryable === 'boolean');
}
const DROPPED_IDLE = /\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET)\b|socket hang up|other side closed|broken pipe|connection reset/iu;
/** A thrown connection drop with no response at all: no status, no reply started. */
function droppedIdle(failure) {
    if (failure.response || !failure.thrown)
        return false;
    const final = failure.final;
    if (final && final.content.length > 0)
        return false;
    const seen = [];
    let error = failure.thrown;
    for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++) {
        const e = error;
        seen.push(String(e.code ?? ''), String(e.message ?? ''));
        error = e.cause;
    }
    return DROPPED_IDLE.test(seen.join(' '));
}
function classifyProviderFailure(error) {
    if (!error ||
        typeof error !== 'object' ||
        typeof error.category !== 'string' ||
        typeof error.code !== 'string')
        return { kind: 'terminal', errorKind: 'unknown' };
    const retryAfterMs = validRetryAfter(error.retryAfterMs);
    if (error.category === 'credential')
        return credentialDecision(error.retryable, retryAfterMs);
    const reason = retryReason(error);
    if (error.retryable === true && reason)
        return retryDecision(reason, retryAfterMs);
    const terminalKinds = {
        identity: 'auth',
        quota: 'usage_limit',
        model: 'not_found',
        request: 'bad_request',
        refusal: 'content_filter',
        dependency: 'unknown',
        platform: 'unknown',
    };
    return {
        kind: 'terminal',
        errorKind: reason ?? terminalKinds[error.category] ?? 'unknown',
    };
}
function validRetryAfter(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function retryReason(error) {
    if (error.category === 'rate-limit')
        return 'rate_limited';
    if (error.category !== 'network')
        return undefined;
    if (error.code === 'timeout')
        return 'timeout';
    if (error.code === 'overload' || error.code === 'overloaded')
        return 'overloaded';
    return 'network';
}
function credentialDecision(retryable, retryAfterMs) {
    if (retryable !== true)
        return { kind: 'terminal', errorKind: 'auth' };
    return recoverDecision(retryAfterMs);
}
function recoverDecision(retryAfterMs) {
    return retryAfterMs === undefined
        ? { kind: 'recover', errorKind: 'auth' }
        : { kind: 'recover', errorKind: 'auth', retryAfterMs };
}
function retryDecision(reason, retryAfterMs) {
    return retryAfterMs === undefined
        ? { kind: 'retry', errorKind: reason, retryReason: reason }
        : { kind: 'retry', errorKind: reason, retryReason: reason, retryAfterMs };
}
//# sourceMappingURL=call.service.js.map