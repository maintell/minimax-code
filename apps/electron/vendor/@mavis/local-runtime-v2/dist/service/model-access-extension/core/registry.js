import { ModelAccessContractError, parseModelAccessManifest } from '@minimax/model-access-sdk';
import { validateHostModelAccessExtension } from './extension-validation.js';
import { assertCompatibleGeneration } from './generation.js';
function validSelection(selection) {
    if (!selection || typeof selection !== 'object')
        return false;
    const { providerId, installationId } = selection;
    return (typeof providerId === 'string' &&
        typeof installationId === 'string' &&
        /^[a-z][a-z0-9-]{0,63}$/u.test(providerId) &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(installationId));
}
/** Host-owned per-profile registry. This class performs no I/O and runs no provider code. */
export class ModelAccessRegistry {
    installations = new Map();
    selectedProviders = new Map();
    generations = new Map();
    leases = new WeakMap();
    /** Restore before admitting requests, even if the selected installation is absent/disabled. */
    constructor(selections = []) {
        if (!Array.isArray(selections) || selections.length > 128)
            throw new ModelAccessContractError('invalid_handlers');
        for (const selection of selections) {
            if (!validSelection(selection) || this.selectedProviders.has(selection.providerId))
                throw new ModelAccessContractError('invalid_handlers');
            this.selectedProviders.set(selection.providerId, selection.installationId);
        }
    }
    selections() {
        return Object.freeze([...this.selectedProviders].map(([providerId, installationId]) => Object.freeze({ providerId, installationId })));
    }
    register(input) {
        if (this.installations.has(input.installationId))
            throw new ModelAccessContractError('invalid_handlers');
        const registered = this.validate(input);
        this.publish(registered, input.host);
        return registered;
    }
    replace(input) {
        const previous = this.installations.get(input.installationId);
        const entry = previous && this.generations.get(previous);
        if (!entry?.host || !input.host || entry.host.epoch === input.host.epoch)
            throw new ModelAccessContractError('invalid_handlers');
        const registered = this.validate(input);
        assertCompatibleGeneration(entry.registration, registered);
        this.publish(registered, input.host);
        entry.retired = true;
        this.collect(entry);
        return registered;
    }
    stage(input) {
        const previous = this.installations.get(input.installationId);
        const entry = previous && this.generations.get(previous);
        const registration = this.validate(input);
        if (previous) {
            if (!entry?.host || !input.host || entry.host.epoch === input.host.epoch)
                throw new ModelAccessContractError('invalid_handlers');
            assertCompatibleGeneration(previous, registration, input.retiredProvider);
        }
        const prepared = this.createGeneration(registration, input.host);
        let completed = false;
        const assertCurrent = () => {
            if (completed || this.installations.get(input.installationId) !== previous)
                throw new ModelAccessContractError('invalid_handlers');
            input.host?.assertCurrent();
        };
        return {
            registration,
            assertCurrent,
            commit: () => {
                if (completed)
                    return;
                completed = true;
                this.generations.set(registration, prepared);
                this.installations.set(input.installationId, registration);
                if (entry) {
                    entry.retired = true;
                    this.collect(entry);
                }
            },
            discard: () => {
                if (completed)
                    return;
                completed = true;
                prepared.retired = true;
                this.collect(prepared);
            },
        };
    }
    acquire(installationId, parent) {
        if (parent) {
            const entry = this.leases.get(parent);
            if (!entry || entry.registration.installationId !== installationId)
                throw new ModelAccessContractError('invalid_handlers');
            parent.assertCurrent();
            return this.retain(entry);
        }
        const registration = this.installations.get(installationId);
        const entry = registration && this.generations.get(registration);
        if (!entry || entry.retired)
            throw new ModelAccessContractError('invalid_handlers');
        return this.retain(entry);
    }
    validate(input) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(input.installationId) ||
            !Number.isSafeInteger(input.generation) ||
            input.generation < 1 ||
            !/^sha256:[a-f0-9]{64}$/u.test(input.digest) ||
            (input.host &&
                (input.host.installationId !== input.installationId ||
                    input.host.packageGeneration !== input.generation))) {
            throw new ModelAccessContractError('invalid_handlers');
        }
        const manifest = parseModelAccessManifest(input.manifest);
        const extension = validateHostModelAccessExtension(manifest, input.extension);
        input.host?.assertCurrent();
        return Object.freeze({
            installationId: input.installationId,
            generation: input.generation,
            digest: input.digest,
            manifest,
            extension,
        });
    }
    publish(registration, host) {
        this.generations.set(registration, this.createGeneration(registration, host));
        this.installations.set(registration.installationId, registration);
    }
    createGeneration(registration, host) {
        const controller = new AbortController();
        const revoke = () => controller.abort();
        const retained = host?.retain();
        retained?.signal.addEventListener('abort', revoke, { once: true });
        if (retained?.signal.aborted)
            revoke();
        return {
            registration,
            host: retained,
            controller,
            revoke,
            holds: 0,
            retired: false,
            revoked: false,
            collected: false,
        };
    }
    retain(entry) {
        if (entry.revoked || entry.controller.signal.aborted)
            throw new ModelAccessContractError('invalid_handlers');
        entry.host?.assertCurrent();
        entry.holds += 1;
        let released = false;
        const assertCurrent = () => {
            if (released || entry.revoked || entry.controller.signal.aborted)
                throw new ModelAccessContractError('invalid_handlers');
            entry.host?.assertCurrent();
        };
        const lease = Object.freeze({
            registration: entry.registration,
            signal: entry.controller.signal,
            epoch: entry.host?.epoch,
            assertCurrent,
            retain: () => {
                assertCurrent();
                return this.retain(entry);
            },
            release: () => {
                if (released)
                    return;
                released = true;
                entry.holds -= 1;
                this.collect(entry);
            },
        });
        this.leases.set(lease, entry);
        return lease;
    }
    collect(entry) {
        if (!entry.retired || entry.holds || entry.collected)
            return;
        entry.collected = true;
        this.generations.delete(entry.registration);
        entry.host?.signal.removeEventListener('abort', entry.revoke);
        if (entry.host)
            entry.disposal = this.releaseHost(entry.host);
    }
    async releaseHost(host) {
        try {
            await host.release();
        }
        catch {
            /* The supervisor owns process termination. */
        }
    }
    list() {
        return Object.freeze([...this.installations.values()]);
    }
    get(installationId) {
        return this.installations.get(installationId);
    }
    selectProvider(providerId, installationId) {
        const installation = this.installations.get(installationId);
        if (!installation?.manifest.providers.some((provider) => provider.id === providerId)) {
            throw new ModelAccessContractError('invalid_handlers');
        }
        this.selectedProviders.set(providerId, installationId);
    }
    /**
     * Provider identity is `(installationId, providerId)`: an official package and a user package
     * may both declare `codex`, and each binding names the installation it belongs to.
     */
    providerOf(installationId, providerId) {
        const registration = this.installations.get(installationId);
        if (!registration?.manifest.providers.some((provider) => provider.id === providerId))
            return undefined;
        const handler = registration.extension.providers[providerId];
        return handler ? Object.freeze({ registration, handler }) : undefined;
    }
    /** Legacy lookup by bare provider id; ambiguous ids require an explicit selection. */
    resolveProvider(providerId) {
        const selected = this.selectedProviders.get(providerId);
        const candidates = selected
            ? [this.installations.get(selected)].filter((item) => !!item)
            : [...this.installations.values()].filter((item) => item.manifest.providers.some((provider) => provider.id === providerId));
        if (candidates.length > 1)
            throw new ModelAccessContractError('provider_conflict');
        const registration = candidates[0];
        const handler = registration?.extension.providers[providerId];
        return registration && handler ? Object.freeze({ registration, handler }) : undefined;
    }
    /** Selection intentionally remains: removing a chosen implementation must not silently fall back. */
    /**
     * Unpublish without cutting work: new admissions fail, existing generation leases stay valid
     * and the generation (and its host) is collected after the last lease is released.
     */
    retire(installationId) {
        const registration = this.installations.get(installationId);
        this.installations.delete(installationId);
        for (const entry of this.generations.values()) {
            if (entry.registration.installationId !== installationId)
                continue;
            entry.retired = true;
            this.collect(entry);
        }
        return registration;
    }
    remove(installationId) {
        const registration = this.installations.get(installationId);
        this.installations.delete(installationId);
        for (const entry of this.generations.values()) {
            if (entry.registration.installationId !== installationId)
                continue;
            entry.revoked = true;
            if (entry.host)
                entry.controller.abort();
            entry.retired = true;
            this.collect(entry);
        }
        return registration;
    }
}
//# sourceMappingURL=registry.js.map