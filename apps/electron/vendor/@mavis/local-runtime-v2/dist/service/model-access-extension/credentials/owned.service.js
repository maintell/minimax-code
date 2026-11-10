import { retainUntilSettled } from '../core/generation.js';
import { accessBinding, errorCode, extensionContext, signInRevoked } from '../core/context.js';
import { identityHash } from './credential-state.js';
import { captureBorrowCredential } from '../borrow/validation.js';
import { captureOwnedLoginResult } from '../login/validation.js';
import { ModelAccessRequestError } from '../request/validation.js';
/** After a failed renewal the key keeps its credential and is not renewed again this long. @internal */
export const RENEWAL_BACKOFF_MS = 30_000;
/** A concurrent slot switch, not a broken credential: read once more. */
const SLOT_RACE_CODES = new Set(['binding_conflict', 'secret_store_busy', 'secret_missing']);
/**
 * Owned credentials: read, renew close to expiry or after a
 * rejection, one renewal per key at a time, a failed renewal keeps the old credential and backs
 * off 30 s. The new payload is written at once; its single-use refresh token is never replayed.
 */
export class ModelAccessOwnedService {
    host;
    timeoutMs;
    producers = new Map();
    backoff = new Map();
    /** Keys whose timed-out exchange has not settled: no second exchange may race it. */
    stuck = new Set();
    lingering = new Set();
    closed = false;
    constructor(host, timeoutMs) {
        this.host = host;
        this.timeoutMs = timeoutMs;
    }
    /** The current credential, renewed first when it is already expired (and renewal may run). */
    async resolve(binding, signal, assertCurrent, parent) {
        assertCurrent();
        const generation = this.host.registry().acquire(binding.installationId, parent);
        try {
            const current = await this.read(binding, signal, generation);
            assertCurrent();
            if (this.usable(current.credential))
                return current;
            const renewed = await this.renew(current, signal, 'normal', generation);
            assertCurrent();
            if (!this.usable(renewed.credential))
                throw new ModelAccessRequestError('request_expired');
            return renewed;
        }
        finally {
            generation.release();
        }
    }
    /** After the vendor refused `rejected`: renew unless another call already replaced it. */
    async forceRenew(binding, rejectedWrites, signal, control) {
        const { assertCurrent, generation: parent } = typeof control === 'function' ? { assertCurrent: control, generation: undefined } : control;
        assertCurrent();
        const generation = this.host.registry().acquire(binding.installationId, parent);
        try {
            if (!this.handler(binding, generation).forceRenewOwned)
                throw new ModelAccessRequestError('request_unavailable');
            const current = await this.read(binding, signal, generation);
            assertCurrent();
            // Another caller renewed after the rejection: that newer credential is the answer.
            if (current.writes !== rejectedWrites && this.usable(current.credential))
                return current;
            const renewed = await this.renew(current, signal, 'forced', generation);
            assertCurrent();
            if (renewed.writes === rejectedWrites || !this.usable(renewed.credential))
                throw new ModelAccessRequestError('request_expired');
            return renewed;
        }
        finally {
            generation.release();
        }
    }
    /**
     * Renews an idle direct sign-in once (one renewal per key with request-time
     * renewals, the same backoff after a failure). 'renewed' when this call wrote a new credential
     * or found one written meanwhile; 'skipped' when the provider has no renewOwned.
     */
    async keepAlive(binding, signal) {
        if (this.closed)
            throw new ModelAccessRequestError('request_closed');
        const generation = this.host.registry().acquire(binding.installationId);
        try {
            if (!this.handler(binding, generation).renewOwned)
                return 'skipped';
            const current = await this.read(binding, signal, generation);
            const renewed = await this.renew(current, signal, 'normal', generation);
            return renewed.writes !== current.writes ? 'renewed' : 'skipped';
        }
        finally {
            generation.release();
        }
    }
    close() {
        this.closed = true;
        for (const { controller } of this.producers.values())
            controller.abort();
    }
    async settled() {
        await Promise.allSettled([...this.producers.keys()]);
    }
    async invalidateInstallation(installationId) {
        const work = [...this.producers].filter(([, entry]) => entry.installationId === installationId);
        for (const [, entry] of work)
            entry.controller.abort();
        await Promise.allSettled(work.map(([promise]) => promise));
    }
    handler(binding, generation) {
        generation.assertCurrent();
        const handler = generation.registration.extension.providers[binding.providerId];
        if (!handler || generation.registration.installationId !== binding.installationId)
            throw new ModelAccessRequestError('request_unavailable');
        return handler;
    }
    context(binding, signal, generation) {
        return extensionContext({
            directories: this.host.directories,
            profileId: this.host.profileId,
            installationId: binding.installationId,
            generation: generation.registration.generation,
            signal: AbortSignal.any([signal, generation.signal]),
        });
    }
    usable(credential) {
        return credential.expiresAt === undefined || credential.expiresAt > Date.now();
    }
    async read(expected, signal, generation) {
        signal.throwIfAborted();
        const writes = this.host.bindings.credentialWrites(expected.providerKey);
        const owned = await this.readSlot(expected.providerKey);
        if (owned.binding.identityHash !== expected.identityHash ||
            owned.binding.identityRevision !== expected.identityRevision ||
            owned.binding.installationId !== expected.installationId ||
            owned.binding.providerId !== expected.providerId)
            throw new ModelAccessRequestError('request_identity_changed');
        const handler = this.handler(owned.binding, generation);
        if (!handler.resolveOwned)
            throw new ModelAccessRequestError('request_unavailable');
        let payload;
        try {
            payload = JSON.parse(owned.payload);
        }
        catch {
            throw new ModelAccessRequestError('request_invalid');
        }
        const resolved = captureBorrowCredential(await handler.resolveOwned(this.context(owned.binding, signal, generation), accessBinding(owned.binding), payload), expected.providerId, true);
        signal.throwIfAborted();
        if (identityHash(resolved.identity) !== expected.identityHash)
            throw new ModelAccessRequestError('request_identity_changed');
        return { binding: owned.binding, credential: resolved, writes };
    }
    /**
     * Reads outside the key lock: a renewal or re-login committing the other slot meanwhile makes
     * the first read miss (pointer moved, old slot being removed). The second read follows the
     * new pointer.
     */
    async readSlot(providerKey) {
        try {
            return await this.host.bindings.read(providerKey);
        }
        catch (error) {
            if (!SLOT_RACE_CODES.has(errorCode(error) ?? ''))
                throw error;
            return this.host.bindings.read(providerKey);
        }
    }
    /**
     * One renewal per key: callers that queue behind a renewal re-read and reuse its result.
     * A failure keeps the stored credential; the key is not renewed again for 30 s.
     */
    renew(previous, signal, mode, parent) {
        if (this.closed)
            throw new ModelAccessRequestError('request_closed');
        const binding = previous.binding;
        const key = binding.providerKey;
        const generation = parent.retain();
        const work = this.host.bindings.withKey(key, async () => {
            try {
                // A renewal that finished while this caller waited already replaced the credential.
                const latest = await this.read(binding, signal, generation);
                if (latest.writes !== previous.writes && this.usable(latest.credential))
                    return latest;
                const until = this.backoff.get(key);
                if (this.stuck.has(key) || (until !== undefined && until > Date.now()))
                    throw new ModelAccessRequestError('request_renewal_network');
                signal.throwIfAborted();
                return await this.produce(latest, mode, generation);
            }
            finally {
                generation.release();
            }
        });
        // The exchange may spend a single-use refresh token: a caller that stops waiting only
        // leaves; the exchange and its write go on (timeout, close and disable still end it).
        return leaveOnAbort(work, signal);
    }
    async produce(current, mode, parent) {
        if (this.producers.size >= 128)
            throw new ModelAccessRequestError('request_busy');
        const handler = this.handler(current.binding, parent);
        const renew = mode === 'forced' ? handler.forceRenewOwned : handler.renewOwned;
        if (!renew)
            throw new ModelAccessRequestError(mode === 'forced' ? 'request_unavailable' : 'request_expired');
        try {
            await this.host.bindings.beginRenewal?.(current.binding.providerKey);
        }
        catch {
            throw new ModelAccessRequestError('request_renewal_commit_failed');
        }
        const controller = new AbortController();
        const generation = parent.retain();
        const onGenerationAbort = () => controller.abort();
        generation.signal.addEventListener('abort', onGenerationAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        const producerSignal = controller.signal;
        const key = current.binding.providerKey;
        // Set when the caller stopped waiting at the deadline: the key lock is released then, so a
        // late result re-takes it before writing (a re-login or sign-out may have run meanwhile).
        let stopped = false;
        const work = retainUntilSettled((async () => {
            let renewed;
            let payload;
            try {
                const result = await renew(this.context(current.binding, producerSignal, generation), accessBinding(current.binding), current.credential);
                // A result is written even after the deadline: the vendor may already have rotated
                // the refresh token, so dropping it would strand the stored credential.
                renewed = captureBorrowCredential(result, current.binding.providerId);
                payload = captureOwnedLoginResult({
                    kind: 'direct-owned',
                    providerId: current.binding.providerId,
                    credentialSchema: current.binding.credentialSchema,
                    identity: renewed.identity,
                    payload: renewed.payload,
                }, current.binding.providerId, current.binding.credentialSchema).payload;
            }
            catch (error) {
                if (this.closed)
                    throw new ModelAccessRequestError('request_closed');
                this.backoff.set(key, Date.now() + RENEWAL_BACKOFF_MS);
                // The vendor said the sign-in is gone vs. the exchange did not complete.
                throw new ModelAccessRequestError(signInRevoked(error) ? 'request_signin_revoked' : 'request_renewal_network');
            }
            if (identityHash(renewed.identity) !== current.binding.identityHash)
                throw new ModelAccessRequestError('request_identity_changed');
            let binding;
            const write = () => this.host.bindings.writeRenewal(current.binding, renewed.identity, payload, current.writes);
            try {
                binding =
                    stopped && !this.host.bindings.usesFileRecords?.()
                        ? await this.host.bindings.withKey(key, write)
                        : await write();
            }
            catch {
                // The new token exists only in memory now; the stored one may already be spent.
                throw new ModelAccessRequestError('request_renewal_commit_failed');
            }
            this.backoff.delete(current.binding.providerKey);
            return {
                binding,
                credential: renewed,
                writes: this.host.bindings.credentialWrites(binding.providerKey),
            };
        })(), () => {
            generation.signal.removeEventListener('abort', onGenerationAbort);
            generation.release();
        });
        this.producers.set(work, { installationId: current.binding.installationId, controller });
        this.host.bindings.retainKeyWork?.(key, work);
        try {
            // Past the deadline a noncooperative exchange is left running (owned until it settles);
            // the key refuses new exchanges meanwhile so a refresh token is never used twice.
            return await Promise.race([
                work,
                new Promise((_, reject) => {
                    const abort = () => {
                        stopped = true;
                        this.backoff.set(key, Date.now() + RENEWAL_BACKOFF_MS);
                        reject(new ModelAccessRequestError(this.closed ? 'request_closed' : 'request_renewal_network'));
                    };
                    if (controller.signal.aborted)
                        abort();
                    controller.signal.addEventListener('abort', abort, { once: true });
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
            if (stopped) {
                this.stuck.add(key);
                this.release(work, key);
            }
            else
                this.producers.delete(work);
        }
    }
    /** The timed-out exchange stays in `producers` (settled() waits) until it really ends. */
    release(work, key) {
        this.lingering.add(this.settle(work, key));
    }
    async settle(work, key) {
        try {
            await work;
        }
        catch {
            /* Its caller already got request_renewal_network. */
        }
        finally {
            this.stuck.delete(key);
            this.producers.delete(work);
        }
    }
}
/** The caller's wait on shared work: its own abort rejects at once, the work keeps running. */
async function leaveOnAbort(work, signal) {
    let abort;
    const stopped = new Promise((_, reject) => {
        abort = () => reject(new ModelAccessRequestError('request_closed'));
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
//# sourceMappingURL=owned.service.js.map