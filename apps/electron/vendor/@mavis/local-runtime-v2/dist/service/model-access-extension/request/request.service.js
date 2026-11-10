import { ModelAccessPolicyError } from '../core/policy.js';
import { extensionSessionKey } from '../core/context.js';
import { ModelAccessCallService } from './call.service.js';
import { ModelAccessOwnedService } from '../credentials/owned.service.js';
import { captureModelAccessCall, ModelAccessRequestError } from './validation.js';
import { ModelAccessAdmission, providerLimitsOf } from './admission.js';
/** Bounded admission; keeps native work and transport cleanup owned until actual settlement. */
export class ModelAccessRequestService {
    host;
    timeoutMs;
    closed = false;
    calls = new Set();
    opening = new Set();
    owned;
    /** Per-account concurrency and RPM limits the package declares (shared by every call). */
    admission;
    constructor(host, timeoutMs = 30_000, admission = new ModelAccessAdmission()) {
        this.host = host;
        this.timeoutMs = timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
            throw new ModelAccessRequestError('request_invalid');
        this.owned = new ModelAccessOwnedService(host, timeoutMs);
        this.admission = admission;
    }
    owns(providerKey) {
        return this.host.bindings.peek(providerKey) !== undefined;
    }
    /** Whether a request on this account would be sent at once (a free slot, room in its minute). */
    ready(providerKey) {
        const binding = this.host.bindings.peek(providerKey);
        if (!binding)
            return true;
        const handler = this.host.registry().get(binding.installationId)?.extension.providers[binding.providerId];
        return this.admission.ready(providerKey, providerLimitsOf(handler));
    }
    begin(input) {
        const captured = captureModelAccessCall(input);
        if (!captured.dependenciesReady)
            return Promise.reject(new ModelAccessPolicyError('dependency_unavailable'));
        this.assertOpen();
        const binding = this.host.bindings.peek(captured.providerKey);
        if (this.host.subscriptionsEnabled?.() === false && binding?.kind !== 'public')
            return Promise.reject(new ModelAccessPolicyError('subscription_disabled'));
        const remote = binding ? this.host.remoteBlock?.(binding) : undefined;
        if (remote)
            return Promise.reject(new ModelAccessPolicyError(remote.code, remote.reason));
        if (this.calls.size + this.opening.size >= 128)
            return Promise.reject(new ModelAccessRequestError('request_busy'));
        const work = this.open(captured);
        this.opening.add(work);
        return this.track(work);
    }
    async track(work) {
        try {
            return await work;
        }
        finally {
            this.opening.delete(work);
        }
    }
    async open(input) {
        const lease = await this.host.bindings.acquire({
            providerKey: input.providerKey,
            signal: input.signal,
        });
        try {
            lease.assertCurrent();
            if (lease.binding.kind !== 'public' && this.host.subscriptionsEnabled?.() === false)
                throw new ModelAccessPolicyError('subscription_disabled');
            const remote = this.host.remoteBlock?.(lease.binding);
            if (remote)
                throw new ModelAccessPolicyError(remote.code, remote.reason);
            const call = new ModelAccessCallService({
                host: this.host,
                lease,
                ...(input.sessionId
                    ? { sessionKey: extensionSessionKey(lease.binding.installationId, input.sessionId) }
                    : {}),
                timeoutMs: this.timeoutMs,
                admission: this.admission,
                finished: () => this.calls.delete(call),
                resolveOwned: (binding, signal, assertCurrent, generation) => this.owned.resolve(binding, signal, assertCurrent, generation),
                forceOwned: (binding, writes, signal, control) => this.owned.forceRenew(binding, writes, signal, control),
            });
            this.calls.add(call);
            return call;
        }
        catch (error) {
            lease.release();
            throw error;
        }
    }
    /** Renews an idle direct sign-in through the same owner as request-time renewals. */
    keepAliveOwned(binding, signal) {
        this.assertOpen();
        return this.owned.keepAlive(binding, signal);
    }
    /** Whether a binding may be used for vendor work now (the same gates as a new call). */
    admits(binding) {
        if (this.closed)
            return false;
        if (this.host.registry().get(binding.installationId) === undefined)
            return false;
        if (binding.kind !== 'public' && this.host.subscriptionsEnabled?.() === false)
            return false;
        return !this.host.remoteBlock?.(binding);
    }
    async invalidateInstallation(installationId) {
        const calls = [...this.calls].filter((call) => call.binding.installationId === installationId);
        await Promise.allSettled([
            ...calls.map((call) => call.close()),
            this.owned.invalidateInstallation(installationId),
        ]);
    }
    invalidateProvider(providerId, installationId) {
        for (const call of this.calls) {
            if (call.binding.providerId === providerId &&
                (installationId === undefined || call.binding.installationId === installationId))
                call.cancel();
        }
    }
    close() {
        this.closed = true;
        this.owned.close();
        for (const call of this.calls)
            call.cancel();
    }
    async settled() {
        await Promise.allSettled([...this.opening]);
        await Promise.allSettled([...this.calls].map((call) => call.close()));
        await this.owned.settled();
    }
    assertOpen() {
        if (this.closed)
            throw new ModelAccessRequestError('request_closed');
    }
}
//# sourceMappingURL=request.service.js.map