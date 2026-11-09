import { captureAccountMasked, captureCommit, captureCommitIdentity, capturePayload, captureSourceRef, identityHash, namespaceHash, ModelAccessCredentialError, nextIdentityRevision, otherSlot, secretSlot, } from './credential-state.js';
/**
 * One record per providerKey. Production file commits combine binding and secret; injected
 * legacy stores retain A/B slots. Per-key renewal locks span processes in file mode.
 */
export class ModelAccessBindingService {
    host;
    secrets;
    locks = new Map();
    operations = new Set();
    /** Runtime-only count of credential writes per key (commit + renewal); never persisted. */
    writes = new Map();
    /** Bumped on every commit/removal of a key: calls opened before it are invalidated. */
    versions = new Map();
    bindingLeases = new Map();
    constructor(host, secrets) {
        this.host = host;
        this.secrets = secrets;
    }
    /** Credential writes this process made for the key (login, borrow commit, renewal). */
    credentialWrites(providerKey) {
        return (this.secrets.version?.(providerKey) ?? 0) + (this.writes.get(providerKey) ?? 0);
    }
    /** Runtime tombstone version; a login/borrow started against an older one is refused. */
    version(providerKey) {
        if (this.secrets.fileRecords)
            return this.peek(providerKey)?.identityRevision ?? -(this.credentialWrites(providerKey) + 1);
        return this.versions.get(providerKey) ?? 0;
    }
    peek(providerKey) {
        const binding = (this.secrets.state?.() ?? this.host.state()).bindings.find((item) => item.providerKey === providerKey);
        return binding ? structuredClone(binding) : undefined;
    }
    /** An owned binding of exactly this account (same extension, provider and identity). */
    sameOwnedAccount(installationId, providerId, hash) {
        const binding = (this.secrets.state?.() ?? this.host.state()).bindings.find((item) => item.kind === 'direct-owned' &&
            item.installationId === installationId &&
            item.providerId === providerId &&
            item.identityHash === hash);
        return binding ? structuredClone(binding) : undefined;
    }
    /** A borrowed binding of exactly this account (same extension, provider and identity). */
    sameBorrowedAccount(installationId, providerId, hash) {
        const binding = (this.secrets.state?.() ?? this.host.state()).bindings.find((item) => item.kind === 'borrowed-current' &&
            item.installationId === installationId &&
            item.providerId === providerId &&
            item.identityHash === hash);
        return binding ? structuredClone(binding) : undefined;
    }
    /** Serializes all writes/renewals of one key (in memory; the host lane serializes persistence). */
    withKey(providerKey, operation) {
        const preceding = this.locks.get(providerKey) ?? Promise.resolve();
        let tail;
        const result = (async () => {
            await settledQuietly(preceding);
            try {
                return await (this.secrets.withKey
                    ? this.secrets.withKey(providerKey, operation)
                    : operation());
            }
            finally {
                // The last holder of the key removes the lock entry.
                if (this.locks.get(providerKey) === tail)
                    this.locks.delete(providerKey);
            }
        })();
        tail = settledQuietly(result);
        this.locks.set(providerKey, tail);
        return this.track(result);
    }
    async beginRenewal(providerKey, borrowedFingerprint) {
        await this.secrets.beginRenewal?.(providerKey, borrowedFingerprint);
    }
    retainKeyWork(providerKey, work) {
        this.secrets.retain?.(providerKey, work);
    }
    usesFileRecords() {
        return this.secrets.fileRecords === true;
    }
    replaceOwned(input) {
        const common = captureCommit(input);
        const identity = captureCommitIdentity(input.identity, common.providerId);
        const accountMasked = captureAccountMasked(input.accountMasked);
        const payload = capturePayload(input.payload);
        const login = input.login ? { sourceId: String(input.login.sourceId) } : undefined;
        const hash = identityHash(identity);
        // Signing in again to an account already connected under another key refreshes that account
        // in place (as magpie's upsertLogin does) instead of adding a second record of it: the new
        // sign-in's credential replaces the old one there, and this key stays untouched.
        const same = this.sameOwnedAccount(common.installationId, common.providerId, hash);
        const providerKey = same && same.providerKey !== common.providerKey ? same.providerKey : common.providerKey;
        return this.withKey(providerKey, async () => {
            if (providerKey === common.providerKey)
                this.assertStart(common, input.startedAt);
            else {
                // The account may have been removed or replaced while this sign-in ran.
                const current = this.peek(providerKey);
                if (common.signal.aborted ||
                    current?.kind !== 'direct-owned' ||
                    current.identityHash !== hash)
                    throw new ModelAccessCredentialError('binding_conflict');
            }
            const previous = this.peek(providerKey);
            this.host.assertInstallation(common, 'direct-owned', common.credentialSchema);
            const slot = otherSlot(previous?.kind === 'direct-owned' ? previous.slot : undefined);
            const next = Object.freeze({
                providerKey,
                installationId: common.installationId,
                providerId: common.providerId,
                credentialSchema: common.credentialSchema,
                kind: 'direct-owned',
                identityHash: hash,
                namespaceHash: namespaceHash(identity),
                ...(accountMasked ? { accountMasked } : {}),
                identityRevision: previous
                    ? nextIdentityRevision(previous)
                    : this.credentialWrites(providerKey) + 1,
                updatedAt: Date.now(),
                ...(this.secrets.fileRecords ? {} : { slot }),
            });
            await this.secrets.write(secretSlot(next), envelope(identity, payload));
            await this.commit(next, previous, common.signal, login);
            return structuredClone(next);
        });
    }
    replaceBorrowed(input) {
        const common = captureCommit(input);
        const identity = captureCommitIdentity(input.identity, common.providerId);
        const accountMasked = captureAccountMasked(input.accountMasked);
        const sourceRef = captureSourceRef(input.sourceRef);
        if (sourceRef.installationId !== common.installationId)
            throw new ModelAccessCredentialError('credential_invalid');
        return this.withKey(common.providerKey, async () => {
            this.assertStart(common, input.startedAt);
            const previous = this.peek(common.providerKey);
            this.host.assertInstallation(common, 'borrowed-current', common.credentialSchema);
            const hash = identityHash(identity);
            // Borrowing an account already connected under another key adds nothing: hand back that
            // binding (its own providerKey) instead of a second record of the same local login, and
            // leave this key untouched. Re-borrowing into the same key still refreshes it in place.
            const existing = this.sameBorrowedAccount(common.installationId, common.providerId, hash);
            if (existing && existing.providerKey !== common.providerKey)
                return existing;
            const lease = this.host.acquireBorrow(sourceRef, common.signal);
            try {
                const next = Object.freeze({
                    providerKey: common.providerKey,
                    installationId: common.installationId,
                    providerId: common.providerId,
                    credentialSchema: common.credentialSchema,
                    kind: 'borrowed-current',
                    identityHash: hash,
                    namespaceHash: namespaceHash(identity),
                    ...(accountMasked ? { accountMasked } : {}),
                    identityRevision: previous
                        ? nextIdentityRevision(previous)
                        : this.credentialWrites(common.providerKey) + 1,
                    updatedAt: Date.now(),
                    sourceRef,
                });
                lease.assertCurrent();
                await this.commit(next, previous, lease.signal);
                return structuredClone(next);
            }
            finally {
                lease.release();
            }
        });
    }
    replacePublic(input) {
        const common = captureCommit(input);
        return this.withKey(common.providerKey, async () => {
            if (common.signal.aborted)
                throw new ModelAccessCredentialError('binding_conflict');
            const previous = this.peek(common.providerKey);
            this.host.assertInstallation(common, 'public', common.credentialSchema);
            const samePublicService = previous?.kind === 'public' &&
                previous.providerId === common.providerId &&
                previous.installationId === common.installationId;
            const next = Object.freeze({
                providerKey: common.providerKey,
                installationId: common.installationId,
                providerId: common.providerId,
                credentialSchema: common.credentialSchema,
                kind: 'public',
                identityRevision: (previous?.identityRevision ?? 0) + (samePublicService ? 0 : 1),
                updatedAt: Date.now(),
            });
            await this.commit(next, previous, common.signal);
            return structuredClone(next);
        });
    }
    /**
     * A renewal's result for the same account: written at once to the other slot, then the pointer
     * moves. Called by the renewal producer while it holds the key (`withKey`). A failure here is
     * thrown to the producer, which marks the key as needing a new sign-in.
     */
    async writeRenewal(expected, identity, payload, expectedWrites) {
        const current = this.assertRenewalCurrent(expected, expectedWrites);
        if (identityHash(identity) !== expected.identityHash)
            throw new ModelAccessCredentialError('binding_conflict');
        const next = Object.freeze({
            ...current,
            ...(this.secrets.fileRecords ? {} : { slot: otherSlot(current.slot) }),
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        });
        await this.secrets.write(secretSlot(next), envelope(identity, capturePayload(payload)));
        const lane = this.host.closingSerial ?? this.host.serial;
        try {
            await lane.call(this.host, async () => {
                const latest = this.host.state();
                const still = latest.bindings.find((item) => item.providerKey === next.providerKey);
                this.assertRenewalCurrent(expected, expectedWrites);
                await this.host.save({
                    bindings: latest.bindings.map((item) => (item === still ? next : item)),
                }, undefined, latest, () => {
                    this.assertRenewalCurrent(expected, expectedWrites);
                });
            });
        }
        catch (error) {
            // The pointer did not move: the slot just written is not the current one.
            await this.removeSlotQuietly(next);
            throw error;
        }
        if (!this.secrets.fileRecords)
            this.writes.set(next.providerKey, this.credentialWrites(next.providerKey) + 1);
        await this.removeSlotQuietly(current);
        return structuredClone(next);
    }
    assertRenewalCurrent(expected, writes) {
        const current = this.peek(expected.providerKey);
        if (!sameOwnedRevision(current, expected) ||
            (writes !== undefined && this.credentialWrites(expected.providerKey) !== writes))
            throw new ModelAccessCredentialError('binding_conflict');
        return current;
    }
    /** Reads the owned payload of the current slot; the identity is verified against the record. */
    async read(providerKey) {
        const binding = this.peek(providerKey);
        if (binding?.kind !== 'direct-owned')
            throw new ModelAccessCredentialError('binding_conflict');
        this.host.assertInstallation(binding, 'direct-owned');
        const raw = await this.secrets.read(secretSlot(binding));
        const current = this.peek(providerKey);
        if (!sameOwnedRevision(current, binding) || current.updatedAt !== binding.updatedAt)
            throw new ModelAccessCredentialError('binding_conflict');
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.payload !== 'string' ||
                !parsed.identity ||
                identityHash(parsed.identity) !== binding.identityHash)
                throw new Error();
            return { binding: current, payload: parsed.payload };
        }
        catch {
            throw new ModelAccessCredentialError('secret_invalid');
        }
    }
    /** Opens a call lease; a later commit/removal of the key aborts it. */
    acquire(input) {
        return this.host.serial(async () => {
            if (input.signal.aborted)
                throw new ModelAccessCredentialError('binding_conflict');
            const current = this.peek(input.providerKey);
            if (!current)
                throw new ModelAccessCredentialError('binding_conflict');
            this.host.assertInstallation(current, current.kind);
            const version = this.version(current.providerKey);
            const controller = new AbortController();
            const generationLease = this.host.acquireGeneration?.(current.installationId, input.generationLease);
            const callerSignal = AbortSignal.any([
                input.signal,
                controller.signal,
                ...(generationLease ? [generationLease.signal] : []),
            ]);
            let policyLease;
            try {
                policyLease =
                    current.kind === 'borrowed-current'
                        ? this.host.acquireBorrow(current.sourceRef, callerSignal, generationLease)
                        : undefined;
            }
            catch (error) {
                generationLease?.release();
                throw error;
            }
            const signal = policyLease?.signal ?? callerSignal;
            const release = this.register(current.providerKey, controller, () => {
                policyLease?.release();
                generationLease?.release();
            });
            signal.addEventListener('abort', release, { once: true });
            return Object.freeze({
                generationLease,
                binding: Object.freeze(current),
                signal,
                release,
                assertCurrent: () => {
                    if (signal.aborted || this.version(current.providerKey) !== version)
                        throw new ModelAccessCredentialError('binding_conflict');
                    policyLease?.assertCurrent();
                    if (generationLease) {
                        // The pinned generation stays valid until revoked, even after it was unpublished
                        // (master switch retirement): a running call finishes on the version it started.
                        generationLease.assertCurrent();
                        return;
                    }
                    this.host.assertInstallation(current, current.kind);
                },
            });
        });
    }
    /** A borrow-policy lease on the current borrowed record of a key. */
    readBorrowed(input) {
        return this.host.serial(async () => {
            const current = this.peek(input.providerKey);
            if (current?.kind !== 'borrowed-current')
                throw new ModelAccessCredentialError('binding_conflict');
            this.host.assertInstallation(current, 'borrowed-current');
            const controller = new AbortController();
            const lease = this.host.acquireBorrow(current.sourceRef, AbortSignal.any([input.signal, controller.signal]), input.generationLease);
            const version = this.version(current.providerKey);
            const release = this.register(current.providerKey, controller, () => lease.release());
            lease.signal.addEventListener('abort', release, { once: true });
            return Object.freeze({
                ...lease,
                binding: Object.freeze(current),
                release,
                assertCurrent: () => {
                    lease.assertCurrent();
                    if (this.version(current.providerKey) !== version)
                        throw new ModelAccessCredentialError('binding_conflict');
                },
            });
        });
    }
    /**
     * The borrowed source now reports another account: the record follows it (identityRevision
     * +1) and calls on the old account are aborted. Same-account reads change nothing persisted.
     */
    observeBorrowed(lease, identity) {
        if (identity.providerId !== lease.binding.providerId)
            throw new ModelAccessCredentialError('credential_invalid');
        const hash = identityHash(identity);
        if (hash === lease.binding.identityHash && lease.binding.namespaceHash)
            return Promise.resolve(lease.binding);
        // Persistence lane only: a borrowed renewal holding the key observes through here too.
        return this.track(this.host.serial(async () => {
            lease.assertCurrent();
            const state = this.host.state();
            const current = state.bindings.find((item) => item.providerKey === lease.binding.providerKey);
            if (current?.kind !== 'borrowed-current')
                throw new ModelAccessCredentialError('binding_conflict');
            const next = Object.freeze({
                ...current,
                identityHash: hash,
                namespaceHash: namespaceHash(identity),
                identityRevision: current.identityRevision + Number(current.identityHash !== hash),
                updatedAt: Date.now(),
            });
            await this.host.save({
                bindings: state.bindings.map((item) => (item === current ? next : item)),
            }, undefined, state, () => lease.assertCurrent());
            if (current.identityHash !== hash)
                this.changed(current.providerKey);
            return structuredClone(next);
        }));
    }
    /**
     * The borrowed source could not be read validly: calls on the key are aborted (the record is
     * kept). Ignored when the record has since changed.
     */
    invalidateBorrowed(lease) {
        return this.host.serial(async () => {
            const current = this.peek(lease.binding.providerKey);
            if (current?.kind !== 'borrowed-current' ||
                current.identityHash !== lease.binding.identityHash ||
                current.identityRevision !== lease.binding.identityRevision)
                return;
            this.changed(current.providerKey);
        });
    }
    /** A borrowed source was rotated by its application (same account): count it as a write. */
    noteBorrowedRotation(providerKey) {
        this.writes.set(providerKey, (this.writes.get(providerKey) ?? 0) + 1);
    }
    /** Deletes the record; an owned credential is offered to the extension's forget first. */
    remove(providerKey) {
        return this.withKey(providerKey, async () => {
            const current = this.peek(providerKey);
            if (!current)
                throw new ModelAccessCredentialError('binding_conflict');
            const forgotten = current.kind === 'direct-owned' ? await this.payloadOf(current) : undefined;
            await this.host.serial(async () => {
                const state = this.host.state();
                await this.host.save({ bindings: state.bindings.filter((item) => item.providerKey !== providerKey) }, current.kind === 'borrowed-current'
                    ? {
                        installationId: current.sourceRef.installationId,
                        sourceId: current.sourceRef.sourceId,
                    }
                    : undefined, state);
            });
            this.changed(providerKey);
            if (current.kind === 'direct-owned') {
                await this.removeBothSlots(current);
                await this.host.forgetOwned(current, forgotten);
            }
        });
    }
    /** Waits for every in-flight write/renewal. */
    async drain() {
        while (this.operations.size)
            await Promise.allSettled([...this.operations]);
    }
    settled() {
        return this.secrets.settled();
    }
    /** Before any secret I/O: the requester is still waiting and nobody committed the key since. */
    assertStart(common, startedAt) {
        if (common.signal.aborted)
            throw new ModelAccessCredentialError('binding_conflict');
        if (startedAt !== undefined && this.version(common.providerKey) !== startedAt)
            throw new ModelAccessCredentialError('binding_conflict');
    }
    async commit(next, previous, signal, login) {
        // Read before the commit (the slot is retired by it); forget only once the commit holds, so
        // a failed commit never leaves the still-current credential without its extension resources.
        const forgotten = previous?.kind === 'direct-owned' ? await this.payloadOf(previous) : undefined;
        try {
            await this.host.serial(async () => {
                // The requester (a login flow, a borrow selection) may be gone by now: last check
                // before the atomic rename; past it the commit stands.
                if (signal.aborted)
                    throw new ModelAccessCredentialError('binding_conflict');
                this.host.assertInstallation(next, next.kind, next.credentialSchema);
                const state = this.host.state();
                await this.host.save({
                    bindings: [
                        ...state.bindings.filter((item) => item.providerKey !== next.providerKey),
                        next,
                    ],
                }, login && { installationId: next.installationId, sourceId: login.sourceId }, state, () => {
                    if (signal.aborted)
                        throw new ModelAccessCredentialError('binding_conflict');
                    this.host.assertInstallation(next, next.kind, next.credentialSchema);
                });
            });
        }
        catch (error) {
            // The new slot was written but not committed: it is the inactive slot, overwritten later.
            if (next.kind === 'direct-owned')
                await this.removeSlotQuietly(next);
            throw error;
        }
        if (!this.secrets.fileRecords)
            this.writes.set(next.providerKey, this.credentialWrites(next.providerKey) + 1);
        this.changed(next.providerKey);
        if (previous?.kind === 'direct-owned') {
            // Same key, other slot: the old slot is retired. Leaving owned mode clears both slots
            // (a stale one from a crash included): nothing would overwrite them later.
            if (next.kind !== 'direct-owned')
                await this.removeBothSlots(previous);
            else if (next.slot !== previous.slot)
                await this.removeSlotQuietly(previous);
            // The extension cleans up what the replaced owned credential left (another account's home).
            await this.host.forgetOwned(previous, forgotten);
        }
    }
    /**
     * The owned payload to hand to forget; undefined when the keychain cannot be read (forget
     * still runs with a null payload, the slot goes anyway).
     */
    async payloadOf(binding) {
        try {
            return (await this.read(binding.providerKey)).payload;
        }
        catch {
            return undefined;
        }
    }
    async removeBothSlots(binding) {
        if (this.secrets.fileRecords)
            return;
        await this.removeSlotQuietly(binding);
        await this.removeSlotQuietly({ ...binding, slot: otherSlot(binding.slot) });
    }
    async removeSlotQuietly(binding) {
        if (this.secrets.fileRecords)
            return;
        try {
            await this.secrets.remove(secretSlot(binding));
        }
        catch {
            // Left behind at most once: the next write to this key overwrites the slot.
            this.host.warn({ event: 'model_access_secret_slot_retained' }, 'secret slot not removed');
        }
    }
    register(providerKey, controller, onRelease) {
        const controllers = this.bindingLeases.get(providerKey) ?? new Set();
        controllers.add(controller);
        this.bindingLeases.set(providerKey, controllers);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            controllers.delete(controller);
            if (controllers.size === 0)
                this.bindingLeases.delete(providerKey);
            controller.abort();
            onRelease();
        };
    }
    changed(providerKey) {
        this.versions.set(providerKey, this.version(providerKey) + 1);
        for (const controller of this.bindingLeases.get(providerKey) ?? [])
            controller.abort();
    }
    async track(operation) {
        this.operations.add(operation);
        try {
            return await operation;
        }
        finally {
            this.operations.delete(operation);
        }
    }
}
function envelope(identity, payload) {
    return JSON.stringify({ identity, payload });
}
function sameOwnedRevision(current, expected) {
    return (current?.kind === 'direct-owned' &&
        current.slot === expected.slot &&
        current.identityHash === expected.identityHash &&
        current.identityRevision === expected.identityRevision &&
        current.providerId === expected.providerId &&
        current.credentialSchema === expected.credentialSchema &&
        current.installationId === expected.installationId);
}
/** Waits for a lock holder; its failure is its own. */
async function settledQuietly(work) {
    try {
        await work;
    }
    catch {
        /* Reported to that holder's caller. */
    }
}
//# sourceMappingURL=binding.service.js.map