import { createHash } from 'node:crypto';
import { ModelAccessPolicyError } from '../core/policy.js';
import { extensionContext } from '../core/context.js';
import { identityHash } from '../credentials/credential-state.js';
import { captureBorrowCredential, ModelAccessBorrowError } from './validation.js';
import { retainUntilSettled } from '../core/generation.js';
/** Host fingerprint of a borrowed credential (payload + expiry), never persisted or shown. */
export function borrowFingerprint(credential) {
    let payload;
    try {
        payload = JSON.stringify(credential.payload) ?? '';
    }
    catch {
        payload = '';
    }
    return createHash('sha256')
        .update(JSON.stringify([identityHash(credential.identity), credential.expiresAt ?? 0, payload]))
        .digest('hex');
}
/**
 * One borrowed renewal per key (the binding owner's key lock). A queued caller re-reads the
 * source first and reuses a credential another caller already rotated.
 */
export class ModelAccessBorrowRenewalService {
    host;
    timeoutMs;
    producers = new Set();
    controllers = new Set();
    /** Keys whose timed-out exchange has not settled: no second exchange may race it. */
    stuck = new Set();
    closed = false;
    constructor(host, timeoutMs) {
        this.host = host;
        this.timeoutMs = timeoutMs;
    }
    run(input) {
        if (this.closed)
            throw new ModelAccessBorrowError('borrow_closed');
        const handler = this.handler(input.binding, input.generation);
        if (input.mode === 'forced' && !handler.forceRenew)
            throw new ModelAccessBorrowError('borrow_unavailable');
        if (input.mode === 'normal' && !handler.renew)
            throw new ModelAccessBorrowError('borrow_unavailable');
        if (this.stuck.has(input.binding.providerKey))
            throw new ModelAccessBorrowError('borrow_failed');
        // The exchange is shared and may spend a single-use token: a caller that stops waiting
        // never aborts it (only the deadline, closing and policy revocation do).
        const generation = this.host.registry().acquire(input.binding.installationId, input.generation);
        const work = this.host.bindings.withKey(input.binding.providerKey, async () => {
            try {
                input.signal.throwIfAborted();
                return await this.bounded({ ...input, generation });
            }
            finally {
                generation.release();
            }
        });
        return waitFor(work, input.signal);
    }
    close() {
        this.closed = true;
        for (const controller of this.controllers)
            controller.abort();
    }
    async settled() {
        await Promise.allSettled([...this.producers]);
    }
    handler(binding, generation) {
        const source = binding.sourceRef;
        generation?.assertCurrent();
        const handler = (generation?.registration ?? this.host.registry().get(source.installationId))
            ?.extension.sources[source.sourceId]?.subscriptionBorrow?.[source.variant];
        if (!handler)
            throw new ModelAccessBorrowError('borrow_unavailable');
        return handler;
    }
    context(lease) {
        return extensionContext({
            directories: this.host.directories,
            profileId: lease.profileId,
            installationId: lease.installationId,
            generation: lease.generation,
            signal: lease.signal,
            enabledTargets: lease.enabledTargets,
            policyRevision: lease.policyRevision,
        });
    }
    usable(credential) {
        return credential.expiresAt === undefined || credential.expiresAt > Date.now();
    }
    async assertIdentity(lease, credential) {
        lease.assertCurrent();
        if (identityHash(credential.identity) === lease.binding.identityHash)
            return;
        await this.host.bindings.observeBorrowed(lease, credential.identity);
        // A logical renewal never adopts a new subject; the observation aborted old calls.
        throw new ModelAccessPolicyError('operation_invalidated');
    }
    async bounded(input) {
        if (this.producers.size >= 128)
            throw new ModelAccessBorrowError('borrow_limit');
        if (this.closed)
            throw new ModelAccessBorrowError('borrow_closed');
        if (this.stuck.has(input.binding.providerKey))
            throw new ModelAccessBorrowError('borrow_failed');
        const controller = new AbortController();
        const generation = input.generation?.retain();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        this.controllers.add(controller);
        const work = retainUntilSettled(this.produce({ ...input, generation }, controller.signal), () => generation?.release());
        this.producers.add(work);
        this.host.bindings.retainKeyWork?.(input.binding.providerKey, work);
        const key = input.binding.providerKey;
        let stopped = false;
        try {
            // A noncooperative exchange past its deadline: stop waiting, keep it owned (settled())
            // and refuse new exchanges of the key until it really ends.
            return await Promise.race([
                work,
                new Promise((_, reject) => {
                    const abort = () => {
                        stopped = true;
                        reject(new ModelAccessBorrowError('borrow_failed'));
                    };
                    if (controller.signal.aborted)
                        abort();
                    controller.signal.addEventListener('abort', abort, { once: true });
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
            this.producers.delete(work);
            if (stopped) {
                this.stuck.add(key);
                // Owned (settled() waits for it) until the exchange really ends.
                this.release(work, key);
            }
        }
    }
    /** A stopped exchange stays owned until it really settles; then the key may renew again. */
    release(work, key) {
        const settled = this.settle(work, key);
        this.producers.add(settled);
        this.producers.add(this.forget(settled));
    }
    async settle(work, key) {
        try {
            await work;
        }
        catch {
            /* Its caller already got borrow_failed. */
        }
        finally {
            this.stuck.delete(key);
        }
    }
    async forget(settled) {
        await settled;
        this.producers.delete(settled);
    }
    async produce(input, signal) {
        const lease = await this.host.bindings.readBorrowed({
            providerKey: input.binding.providerKey,
            signal,
            generationLease: input.generation,
        });
        try {
            if (lease.binding.identityHash !== input.binding.identityHash ||
                lease.binding.identityRevision !== input.binding.identityRevision)
                throw new ModelAccessPolicyError('operation_invalidated');
            const handler = this.handler(lease.binding, input.generation);
            const context = this.context(lease);
            const source = lease.binding.sourceRef;
            const current = captureBorrowCredential(await handler.resolve(context, source), lease.binding.providerId, true);
            await this.assertIdentity(lease, current);
            const currentPrint = borrowFingerprint(current);
            // Another caller (or the application itself) already rotated it: reuse that one.
            if (currentPrint !== input.previousFingerprint && this.usable(current)) {
                this.host.bindings.noteBorrowedRotation(lease.binding.providerKey);
                return { binding: lease.binding, credential: current, fingerprint: currentPrint };
            }
            const renew = input.mode === 'forced' ? handler.forceRenew : handler.renew;
            if (!renew)
                throw new ModelAccessBorrowError('borrow_unavailable');
            lease.assertCurrent();
            try {
                await this.host.bindings.beginRenewal?.(lease.binding.providerKey, currentPrint);
            }
            catch {
                throw new ModelAccessBorrowError('borrow_failed');
            }
            const credential = captureBorrowCredential(await renew(context, source, current), lease.binding.providerId);
            await this.assertIdentity(lease, credential);
            lease.assertCurrent();
            if (!this.usable(credential))
                throw new ModelAccessBorrowError('borrow_expired');
            this.host.bindings.noteBorrowedRotation(lease.binding.providerKey);
            return { binding: lease.binding, credential, fingerprint: borrowFingerprint(credential) };
        }
        finally {
            lease.release();
        }
    }
}
/** The caller's wait on shared work: its own abort rejects at once, the work keeps running. */
async function waitFor(work, signal) {
    let abort;
    const stopped = new Promise((_, reject) => {
        abort = () => reject(new ModelAccessPolicyError('operation_invalidated'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted)
        abort();
    try {
        return await Promise.race([work, stopped]);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
//# sourceMappingURL=renewal.service.js.map