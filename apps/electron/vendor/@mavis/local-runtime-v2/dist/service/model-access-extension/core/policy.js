import { capabilityTargetKey as key, parseModelAccessPolicyPreferences, } from './policy-preferences.js';
export class ModelAccessPolicyError extends Error {
    code;
    reason;
    constructor(code, 
    /** Remote machine reason code (localized by Desktop); only for remote refusals. */
    reason) {
        super(code);
        this.code = code;
        this.reason = reason;
        this.name = 'ModelAccessPolicyError';
    }
}
function capabilityEntries(source, capability) {
    if (capability === 'login')
        return source?.capabilities.login?.methods;
    if (capability === 'subscriptionBorrow')
        return source?.capabilities.subscriptionBorrow?.variants;
    if (capability === 'apiKeyScan')
        return source?.capabilities.apiKeyScan?.readers;
    return undefined;
}
function sourceBorrowTargets(installationId, source) {
    return (source.capabilities.subscriptionBorrow?.variants ?? []).flatMap((entry) => entry.targets.map((target) => ({
        installationId,
        sourceId: source.id,
        capability: 'subscriptionBorrow',
        entryId: entry.id,
        target,
    })));
}
/** Every declared borrow target of every currently registered installation. */
function registeredBorrowTargets(registry) {
    return registry
        .list()
        .flatMap((registration) => registration.manifest.sources.flatMap((source) => sourceBorrowTargets(registration.installationId, source)));
}
export class ModelAccessCapabilityPolicy {
    profileId;
    registry;
    remote;
    revision = 0;
    subscriptionPreference;
    closed = false;
    globals = {
        login: true,
        subscriptionBorrow: false,
        apiKeyScan: false,
    };
    globalRevisions = {
        login: 0,
        subscriptionBorrow: 0,
        apiKeyScan: 0,
    };
    targets = new Map();
    leases = new Set();
    constructor(profileId, registry, preferences, remote) {
        this.profileId = profileId;
        this.registry = registry;
        this.remote = remote;
        if (!profileId.trim())
            throw new ModelAccessPolicyError('operation_invalidated');
        if (preferences !== undefined) {
            const parsed = parseModelAccessPolicyPreferences(preferences, profileId);
            Object.assign(this.globals, parsed.globals);
            this.subscriptionPreference = parsed.subscriptionsEnabled;
            for (const target of parsed.targets)
                this.targets.set(key(target), { target, enabled: target.enabled, revision: 0 });
        }
    }
    preferences() {
        return Object.freeze({
            schemaVersion: 1,
            profileId: this.profileId,
            ...(this.subscriptionPreference === undefined
                ? {}
                : { subscriptionsEnabled: this.subscriptionPreference }),
            globals: Object.freeze({ ...this.globals }),
            targets: Object.freeze([...this.targets.values()].map(({ target, enabled }) => Object.freeze({ ...target, enabled }))),
        });
    }
    sync(preferences) {
        if (preferences.subscriptionsEnabled !== this.subscriptionPreference)
            this.setSubscriptionsEnabled(preferences.subscriptionsEnabled !== false);
        for (const capability of ['login', 'subscriptionBorrow', 'apiKeyScan']) {
            const next = preferences.globals[capability];
            if (this.globals[capability] !== next) {
                this.globals[capability] = next;
                this.globalRevisions[capability] = ++this.revision;
                this.invalidate((lease) => lease.request.capability === capability);
            }
        }
        const next = new Map(preferences.targets.map((target) => [key(target), target]));
        for (const targetKey of new Set([...this.targets.keys(), ...next.keys()])) {
            const target = next.get(targetKey);
            const old = this.targets.get(targetKey);
            if (target?.enabled === old?.enabled)
                continue;
            if (target)
                this.targets.set(targetKey, { target, enabled: target.enabled, revision: ++this.revision });
            else
                this.targets.delete(targetKey);
            this.invalidate((lease) => lease.targetKeys.includes(targetKey));
        }
    }
    subscriptionsEnabled() {
        return this.subscriptionPreference !== false;
    }
    setSubscriptionsEnabled(enabled) {
        this.subscriptionPreference = enabled;
        this.revision += 1;
        // Existing borrowed streams retain their leases. New work is refused at admission;
        // outstanding logins must not commit after the user disabled subscriptions.
        if (!enabled)
            this.invalidate((lease) => lease.request.capability === 'login');
        if (enabled) {
            this.globals.login = true;
            this.globals.subscriptionBorrow = true;
        }
    }
    version() {
        return this.revision;
    }
    /**
     * Remote rule for a capability of a source, or for one entry point (entry + target) when given;
     * independent of the user's own switches.
     */
    remoteBlock(capability, sourceId, entry, installationId) {
        if (this.remote?.serviceDisabled?.())
            return {};
        if (installationId !== undefined &&
            this.remote?.officialInstallation?.(installationId) === false)
            return undefined;
        if (installationId !== undefined && this.remote?.capabilityBlockFor)
            return this.remote.capabilityBlockFor(installationId, capability, sourceId, entry);
        return this.remote?.capabilityBlock(capability, sourceId, entry);
    }
    /**
     * Called after the remote rules change. New admissions are refused by acquire(). Pending
     * sign-ins and API candidates are revoked so they cannot commit; borrow leases also carry
     * running requests, which are allowed to finish.
     */
    remoteChanged() {
        this.invalidate((lease) => lease.request.capability !== 'subscriptionBorrow' &&
            lease.enabledTargets.some((target) => !!this.remoteBlock(lease.request.capability, lease.request.sourceId, { entryId: lease.request.entryId, target }, lease.request.installationId)));
    }
    entry(input, pinned) {
        const registration = pinned ?? this.registry.get(input.installationId);
        const source = registration?.manifest.sources.find((candidate) => candidate.id === input.sourceId);
        const entries = capabilityEntries(source, input.capability);
        const entry = entries?.find((candidate) => candidate.id === input.entryId);
        if (!registration || !entry)
            throw new ModelAccessPolicyError('unsupported_capability');
        return { registration, entry };
    }
    describe(input) {
        const { entry } = this.entry(input);
        return Object.freeze(entry.targets.map((target) => Object.freeze({
            target,
            enabled: !this.remoteBlock(input.capability, input.sourceId, { entryId: input.entryId, target }, input.installationId) &&
                this.globals[input.capability] &&
                this.targets.get(key({ ...input, target }))?.enabled === true,
        })));
    }
    setTarget(input, enabled) {
        const { entry } = this.entry(input);
        if (!entry.targets.includes(input.target))
            throw new ModelAccessPolicyError('unsupported_capability');
        const targetKey = key(input);
        // An explicit off is recorded even for a never-enabled target so callers can tell
        // "user said no" apart from "no preference yet" (login click-consent relies on it).
        const current = this.targets.get(targetKey);
        if (current && current.enabled === enabled)
            return;
        this.targets.set(targetKey, {
            enabled,
            revision: ++this.revision,
            target: Object.freeze({
                installationId: input.installationId,
                sourceId: input.sourceId,
                capability: input.capability,
                entryId: input.entryId,
                target: input.target,
            }),
        });
        this.invalidate((lease) => lease.targetKeys.includes(targetKey));
    }
    /** Revoke only existing preferences, including inactive packages; never enables unknown IDs. */
    disableBorrowSources(installationId, sourceIds) {
        for (const [targetKey, item] of this.targets) {
            const target = item.target;
            if (target.installationId !== installationId || target.capability !== 'subscriptionBorrow')
                continue;
            if (sourceIds && !sourceIds.includes(target.sourceId))
                continue;
            if (!item.enabled)
                continue;
            this.targets.set(targetKey, { ...item, enabled: false, revision: ++this.revision });
            this.invalidate((lease) => lease.targetKeys.includes(targetKey));
        }
    }
    /** Only a real off -> on transition enables currently registered borrow targets. */
    setGlobal(capability, enabled) {
        if (!Object.hasOwn(this.globals, capability))
            throw new ModelAccessPolicyError('unsupported_capability');
        if (this.globals[capability] === enabled)
            return;
        this.globals[capability] = enabled;
        this.globalRevisions[capability] = ++this.revision;
        if (enabled && capability === 'subscriptionBorrow') {
            for (const target of registeredBorrowTargets(this.registry)) {
                this.targets.set(key(target), {
                    enabled: true,
                    revision: this.revision,
                    target: Object.freeze(target),
                });
            }
        }
        this.invalidate((lease) => lease.request.capability === capability);
    }
    assertAdmissible(input) {
        if (input.capability !== 'apiKeyScan' && !this.subscriptionsEnabled())
            throw new ModelAccessPolicyError('subscription_disabled');
        if (this.closed)
            throw new ModelAccessPolicyError('operation_invalidated');
        if (input.signal?.aborted)
            throw new ModelAccessPolicyError('operation_invalidated');
        if (this.remote?.serviceDisabled?.())
            throw new ModelAccessPolicyError('service_disabled');
        // Source/global layers here; entry rules are applied per target by acquirePinned.
        const remote = this.remoteBlock(input.capability, input.sourceId, undefined, input.installationId);
        if (remote)
            throw new ModelAccessPolicyError('remote_disabled', remote.reason);
        if (!this.globals[input.capability])
            throw new ModelAccessPolicyError('capability_disabled');
        if (input.capability === 'login')
            assertLoginAdmissible(input);
    }
    acquire(requestInput, parent) {
        if (!parent)
            this.entry(requestInput);
        const generationLease = this.registry.acquire(requestInput.installationId, parent);
        try {
            return this.acquirePinned(requestInput, generationLease);
        }
        catch (error) {
            generationLease.release();
            throw error;
        }
    }
    acquirePinned(requestInput, generationLease) {
        const input = Object.freeze({
            ...requestInput,
            signal: requestInput.signal
                ? AbortSignal.any([requestInput.signal, generationLease.signal])
                : generationLease.signal,
            targets: requestInput.targets ? Object.freeze([...requestInput.targets]) : undefined,
        });
        const { registration, entry } = this.entry(input, generationLease.registration);
        this.assertAdmissible(input);
        const requested = input.targets ?? entry.targets;
        if (new Set(requested).size !== requested.length ||
            requested.some((target) => !entry.targets.includes(target))) {
            throw new ModelAccessPolicyError('unsupported_capability');
        }
        // A remotely stopped entry point is skipped like an off target; when it was the only
        // requested target the refusal is the remote one.
        const remoteBlocked = (target) => this.remoteBlock(input.capability, input.sourceId, { entryId: input.entryId, target }, input.installationId);
        const allowed = requested.filter((target) => !remoteBlocked(target));
        if (allowed.length === 0 && requested.length > 0)
            throw new ModelAccessPolicyError('remote_disabled', remoteBlocked(requested[0])?.reason);
        const enabledTargets = Object.freeze(allowed.filter((target) => this.targets.get(key({ ...input, target }))?.enabled === true));
        if (enabledTargets.length === 0)
            throw new ModelAccessPolicyError('capability_disabled');
        const targetKeys = enabledTargets.map((target) => key({ ...input, target }));
        const controller = new AbortController();
        const request = Object.freeze({ ...input, targets: Object.freeze([...requested]) });
        const onAbort = () => {
            controller.abort(new ModelAccessPolicyError('operation_invalidated'));
            lease.release();
        };
        let released = false;
        const lease = {
            request,
            registration,
            controller,
            targetKeys,
            enabledTargets,
            revisions: targetKeys.map((target) => this.targets.get(target).revision),
            globalRevision: this.globalRevisions[input.capability],
            release: () => {
                if (released)
                    return;
                released = true;
                input.signal?.removeEventListener('abort', onAbort);
                this.leases.delete(lease);
                generationLease.release();
            },
        };
        input.signal?.addEventListener('abort', onAbort, { once: true });
        this.leases.add(lease);
        return Object.freeze({
            generationLease,
            profileId: this.profileId,
            installationId: input.installationId,
            generation: registration.generation,
            policyRevision: this.revision,
            enabledTargets,
            signal: controller.signal,
            assertCurrent: () => {
                try {
                    generationLease.assertCurrent();
                }
                catch {
                    onAbort();
                }
                if (released ||
                    controller.signal.aborted ||
                    this.globalRevisions[input.capability] !== lease.globalRevision ||
                    targetKeys.some((target, index) => this.targets.get(target)?.revision !== lease.revisions[index])) {
                    onAbort();
                    throw new ModelAccessPolicyError('operation_invalidated');
                }
            },
            release: lease.release,
        });
    }
    /** Call before removing/replacing a registration so running I/O also receives cancellation. */
    invalidateInstallation(installationId) {
        this.invalidate((lease) => lease.registration.installationId === installationId);
    }
    close() {
        this.closed = true;
        this.invalidate(() => true);
    }
    invalidate(predicate) {
        for (const lease of [...this.leases]) {
            if (!predicate(lease))
                continue;
            lease.controller.abort(new ModelAccessPolicyError('operation_invalidated'));
            lease.release();
        }
    }
}
/** A sign-in starts only from an explicit user action, once its dependencies are ready. */
function assertLoginAdmissible(input) {
    if (input.explicitUserAction !== true)
        throw new ModelAccessPolicyError('explicit_action_required');
    if (input.dependenciesReady !== true)
        throw new ModelAccessPolicyError('dependency_unavailable');
}
//# sourceMappingURL=policy.js.map