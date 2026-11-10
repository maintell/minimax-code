import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDevelopmentBuild } from '@mavis/config';
import { logger } from '@mavis/shared/local-runtime-logging';
import { ModelAccessCapabilityPolicy } from './core/policy.js';
import { ModelAccessRegistry } from './core/registry.js';
import { composeModelAccessPackageServices, invalidateDisabled, } from './lifecycle/package-services.js';
import { applyRemoteRules, remoteRequestBlock, remoteWithdrawn, } from './lifecycle/remote-switch.js';
import { assertRegistrable, borrowSourcesOfAgent, trustedActivationDigest, newInstallation, restagedInstallation, validateModelAccessSnapshot, } from './lifecycle/registration.js';
import { ModelAccessSubprocessLifecycle, } from './package-subprocess.js';
import { InProcessExtensions } from './installation/in-process.js';
import { ModelAccessUserPackages, retaggedInstallation, unchangedRegistration, } from './installation/user-packages.js';
import { observeModelAccessWork, settleQuietly, settleWithin } from './core/settlement.js';
import { modelAccessOrigin, } from './contracts.js';
import { ModelAccessPackageError, failureState, assertPackageOptions, isUserTrust, } from './errors.js';
import { ModelAccessPackageRepository } from './package-state.repository.js';
import { ModelAccessInstallationHousekeeping } from './installation/housekeeping.js';
import { modelAccessSnapshotPath, previewLocalModelAccessPackage, snapshotLocalModelAccessPackage, } from './package-snapshot.adapter.js';
import { migrateOsSlots, removeLegacySlots } from './credentials/migrations.js';
import { migrateInstallationCredentials } from './credentials/migrate-installation.js';
import { ModelAccessFileRecords } from './credentials/file-records.js';
import { EMPTY_REMOTE_DELIVERY, ModelAccessRemotePolicy, ModelAccessRevocationCheck, } from './official/remote-state.js';
import { MODEL_ACCESS_REMOTE_ENV, resolveRemoteDeliverySwitch, } from './official/delivery.js';
import { modelAccessRemoteView } from './official/remote-view.js';
/**
 * Host model access SDK contract version reported to official delivery. The host loads `^1`
 * (schema 1) and `^2` (schema 2) packages; the handler SPI is shared.
 */
export const MODEL_ACCESS_HOST_SDK_VERSION = '2.0.0';
export class ModelAccessPackageService {
    options;
    mutableRegistry = new ModelAccessRegistry();
    get registry() {
        return this.mutableRegistry;
    }
    capabilityPolicy;
    housekeeping;
    get policy() {
        return this.capabilityPolicy;
    }
    /** Effective remote rules; empty (allows everything) unless official delivery is enabled. */
    remotePolicy = new ModelAccessRemotePolicy();
    state;
    repository;
    tail = Promise.resolve();
    inProcess;
    processStops = new Set();
    closed = false;
    ready = false;
    legacyCredentialState;
    subprocess;
    bindingService;
    get bindings() {
        return this.bindingService;
    }
    /**
     * Metadata-only binding view for model-system (views, deletion, failover stamps): the record
     * plus the runtime credential-write count; credentials stay inside the binding owner.
     */
    bindingFacts = {
        peek: (providerKey) => {
            const binding = this.bindingService.peek(providerKey);
            return binding
                ? { ...binding, credentialWrites: this.bindingService.credentialWrites(providerKey) }
                : undefined;
        },
        remove: (providerKey) => this.bindingService.remove(providerKey),
    };
    loginService;
    get login() {
        return this.loginService;
    }
    borrowService;
    get borrow() {
        return this.borrowService;
    }
    apiScanService;
    get apiScan() {
        return this.apiScanService;
    }
    requestService;
    get requests() {
        return {
            owns: (key) => this.requestService.owns(key),
            ready: (key) => this.requestService.ready(key),
            begin: async (input) => {
                await this.synchronize();
                this.subprocess.noteRequest();
                return this.requestService.begin(input);
            },
        };
    }
    directories;
    secrets;
    keepAlive;
    fileRecords;
    /** Secret-store override is a direct-module test seam, not part of the host factory. */
    constructor(options, secrets, processOptions = {}) {
        this.options = options;
        assertPackageOptions(options);
        this.inProcess = new InProcessExtensions(options, () => this.closed);
        this.remotePolicy.setOfficialResolver((installationId) => this.isOfficial(installationId), (installationId) => this.state.installations.find((item) => item.installationId === installationId)?.name);
        this.subprocess = new ModelAccessSubprocessLifecycle({
            options,
            closed: () => this.closed,
            serviceDisabled: () => this.remotePolicy.serviceDisabled(),
            registry: () => this.mutableRegistry,
            policy: () => this.capabilityPolicy,
            item: (id) => this.state.installations.find((item) => item.installationId === id),
            enqueue: (operation) => this.enqueue(operation),
            put: (item) => this.put(item),
            ensureDataDir: (id) => this.housekeeping.ensureDataDir(id),
            // Every subprocess activation (startup restore, update, rollback) passes this gate.
            validateSnapshot: (id, digest) => this.validateActivatable(id, digest),
            boundProvider: (id, providerId) => this.credentialState().bindings.some((binding) => binding.installationId === id && binding.providerId === providerId),
        }, processOptions);
        this.capabilityPolicy = new ModelAccessCapabilityPolicy(options.profileId, this.mutableRegistry, undefined, this.remotePolicy);
        this.state = { schemaVersion: 1, profileId: options.profileId, installations: [] };
        this.fileRecords = secrets
            ? undefined
            : new ModelAccessFileRecords(options.root, options.profileId);
        this.repository = new ModelAccessPackageRepository(options.root, options.profileId, !!this.fileRecords);
        // root is <profile>/model-access; its parent is the MCode profile root readers deny.
        this.directories = Object.freeze({
            root: options.root,
            hostDataDir: path.dirname(options.root),
        });
        this.housekeeping = new ModelAccessInstallationHousekeeping({
            root: options.root,
            profileId: options.profileId,
            directories: this.directories,
            ...(options.disposeTimeoutMs !== undefined
                ? { disposeTimeoutMs: options.disposeTimeoutMs }
                : {}),
            registry: () => this.mutableRegistry,
        });
        this.secrets = secrets ?? this.fileRecords;
        const services = composeModelAccessPackageServices({
            options,
            directories: this.directories,
            secrets: this.secrets,
            housekeeping: this.housekeeping,
            serial: (operation) => this.serial(operation),
            enqueue: (operation) => this.enqueue(operation),
            registry: () => this.mutableRegistry,
            policy: () => this.capabilityPolicy,
            credentials: () => this.credentialState(),
            saveCredentials: (credentials, disableBorrow, expected, beforeCommit) => this.saveCredentials(credentials, disableBorrow, expected, beforeCommit),
            assertInstallation: (input, kind, credentialSchema) => this.assertCredentialInstallation(input, kind, credentialSchema),
            refreshShared: () => this.refreshShared(),
            remoteBlock: (binding) => this.remoteRequestBlock(binding),
            usable: () => this.ready && !this.closed,
        });
        this.bindingService = services.bindings;
        this.loginService = services.login;
        this.borrowService = services.borrow;
        this.apiScanService = services.apiScan;
        this.requestService = services.requests;
        this.keepAlive = services.keepAlive;
    }
    async initialize() {
        if (this.ready || this.closed)
            throw new ModelAccessPackageError('service_closed');
        await this.repository.open();
        try {
            this.state = await this.repository.read();
            if (this.fileRecords) {
                try {
                    await this.migrateFileRecords();
                }
                catch {
                    this.legacyCredentialState = this.state.credentials;
                    logger.warn({ event: 'model_access_legacy_migration_required' }, 'Previous credentials retained; migration needs attention');
                }
            }
            else {
                await removeLegacySlots(this.repository, this.secrets, this.state, this.options.root);
                this.state = await this.repository.read();
            }
            this.mutableRegistry = new ModelAccessRegistry(this.state.providerSelections);
            this.capabilityPolicy = new ModelAccessCapabilityPolicy(this.options.profileId, this.mutableRegistry, this.state.preferences, this.remotePolicy);
            this.loadRemotePolicy();
            for (const item of [...this.state.installations]) {
                // Dev packages belong to a session of an earlier run; they are removed below.
                if (!item.enabled || item.trustSource === 'dev-session')
                    continue;
                await this.restoreInstallation(item.installationId);
            }
            // Nothing ships inside the client: official packages come from remote delivery, user
            // packages from explicit folder/zip installs.
            this.ready = true;
            this.keepAlive?.start();
            observeModelAccessWork(this.userPackages.dropStaleDevPackages());
        }
        catch (error) {
            this.capabilityPolicy.close();
            for (const item of this.mutableRegistry.list()) {
                this.mutableRegistry.remove(item.installationId);
                await this.inProcess.dispose(item.extension);
            }
            await this.subprocess.close();
            await this.releaseOwnership();
            throw error;
        }
    }
    /** New admissions reconcile persistent desired state; existing calls keep their generation. */
    async synchronize() {
        if (!this.fileRecords || this.closed || !this.ready)
            return;
        await this.serial(async () => { });
        if (this.options.executionMode !== 'subprocess')
            return;
        for (const item of this.state.installations) {
            if (this.needsActivation(item))
                await this.subprocess.activate(item.installationId);
        }
    }
    needsActivation(item) {
        if (!item.enabled)
            return false;
        if (item.pendingDigest)
            return true;
        if (this.mutableRegistry.get(item.installationId)?.digest === item.activeDigest)
            return false;
        // A crashed host restarts on its own backoff, not on every request.
        return !this.subprocess.holdsRecovery(item.installationId);
    }
    refreshShared() {
        if (!this.fileRecords)
            return;
        const current = this.repository.readCurrent();
        this.legacyCredentialState = current.credentials;
        const installations = current.installations.map((item) => {
            const old = this.state.installations.find((candidate) => candidate.installationId === item.installationId);
            return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
        });
        this.state = { ...current, installations, credentials: this.fileRecords.state() };
        if (current.preferences)
            this.capabilityPolicy.sync(current.preferences);
        this.loadRemotePolicy();
        // Another process disabled or removed an installation: its leases and requests end here too.
        invalidateDisabled(this.mutableRegistry, installations, this.capabilityPolicy, this.requestService);
    }
    /** Product owner with delivery on (default; env first, then the Developer Tools opt-in). */
    remoteEnabled = () => !!this.options.officialDelivery &&
        resolveRemoteDeliverySwitch(process.env[MODEL_ACCESS_REMOTE_ENV], this.state.remoteDelivery?.optIn).enabled;
    treeDigestOverride;
    get treeDigest() {
        return this.treeDigestOverride ?? this.options.officialDelivery?.contentDigest;
    }
    revocation = new ModelAccessRevocationCheck({
        policy: this.remotePolicy,
        delivery: () => this.remoteDelivery(),
        official: (id) => this.isOfficial(id),
        nameOf: (id) => this.state.installations.find((item) => item.installationId === id)?.name,
        treeDigest: () => this.treeDigest,
        snapshotDirectory: (localDigest) => this.physicalSnapshot(localDigest),
        realpath: (directory) => realpath(directory),
    });
    isRevoked(localDigest, directory, installationId) {
        return this.revocation.revoked(localDigest, directory, installationId);
    }
    async assertNotRevoked(localDigest, directory, installationId) {
        if (await this.isRevoked(localDigest, directory, installationId))
            throw new ModelAccessPackageError('package_revoked');
    }
    async physicalSnapshot(localDigest) {
        const directory = modelAccessSnapshotPath(this.options.root, localDigest);
        return path.join(await realpath(path.dirname(directory)), path.basename(directory));
    }
    async validateActivatable(installationId, digest) {
        const validated = await this.validateSnapshot(installationId, digest);
        await this.assertNotRevoked(digest, validated.directory, installationId);
        return validated;
    }
    remoteListeners = new Set();
    loadRemotePolicy() {
        applyRemoteRules({
            remotePolicy: this.remotePolicy,
            registry: () => this.mutableRegistry,
            policy: () => this.capabilityPolicy,
            login: this.loginService,
            subprocess: this.subprocess,
            subprocessMode: this.options.executionMode === 'subprocess',
            isOfficial: (id) => this.isOfficial(id),
            running: () => this.ready && !this.closed,
            installations: () => this.state.installations,
            restore: (id) => this.restoreInstallation(id),
            listeners: this.remoteListeners,
        }, this.state.remoteDelivery, this.remoteEnabled());
    }
    /** Delivery composition only: the delivery owner decides whether remote rules apply. */
    attachRemoteDelivery(input = {}) {
        if (input.enabled)
            this.remoteEnabled = input.enabled;
        if (input.contentDigest)
            this.treeDigestOverride = input.contentDigest;
        this.loadRemotePolicy();
        return {
            host: this.officialSyncHost(),
            refresh: () => this.loadRemotePolicy(),
            onChange: (listener) => {
                this.remoteListeners.add(listener);
                return () => this.remoteListeners.delete(listener);
            },
        };
    }
    /** Remote rules and presentation for the UI; empty while delivery or the master switch is off. */
    remoteView(status) {
        return modelAccessRemoteView({
            root: this.options.root,
            status,
            serviceDisabled: this.remotePolicy.serviceDisabled(),
            catalog: this.remotePolicy.catalog(),
        });
    }
    remoteDelivery() {
        return this.state.remoteDelivery ?? EMPTY_REMOTE_DELIVERY;
    }
    /** Serialized read-modify-write of `remoteDelivery`; other state fields are untouched. */
    updateRemoteDelivery(change) {
        return this.serial(async () => {
            const remoteDelivery = change(this.remoteDelivery());
            const next = { ...this.state, remoteDelivery };
            await this.commitState(next);
            this.loadRemotePolicy();
            return remoteDelivery;
        });
    }
    officialSyncHost() {
        return {
            root: this.options.root,
            platform: this.options.platform,
            sdkVersion: MODEL_ACCESS_HOST_SDK_VERSION,
            remoteDelivery: () => {
                this.refreshShared();
                return this.remoteDelivery();
            },
            updateRemoteDelivery: (change) => this.updateRemoteDelivery(change),
            installations: () => this.list(),
            snapshotManifest: async (installationId, digest) => {
                try {
                    return (await this.validateSnapshot(installationId, digest)).preview.manifest;
                }
                catch {
                    return undefined;
                }
            },
            install: (source, digest) => this.registerTrusted(source, digest),
            rollback: (installationId, digest) => this.rollback(installationId, digest),
            enable: (installationId) => this.enable(installationId),
            // Remote revocation (or a completed split) is the only package-level stop of an official package.
            disable: (installationId) => this.disablePackage(installationId),
            migrateCredentials: (input) => this.migrateCredentials(input),
            boundInstallation: (installationId) => this.credentialState().bindings.some((binding) => binding.installationId === installationId),
        };
    }
    /**
     * Official packages (remotely delivered, or an older build's bundle) are owned by remote
     * delivery while it is on: the user turns capabilities off, never the package itself.
     * Development imports stay under user control.
     */
    assertUserManaged(installationId) {
        const item = this.item(installationId);
        if (item.trustSource === 'bundled' && this.remotePolicy.enabled())
            throw new ModelAccessPackageError('official_package_managed');
    }
    /**
     * Official delivery install: snapshot, digest trust and activation like any package. The
     * persisted trustSource stays `bundled` so an older Desktop can still read state.json; the
     * displayed source (official vs an older build's bundle) comes from the remote digest mapping.
     */
    async registerTrusted(source, digest) {
        this.assertReady();
        const installation = await this.register(source, digest, 'bundled');
        return installation.enabled ? installation : this.enable(installation.installationId);
    }
    /** Unknown installations count as official so catalog rules fail closed. */
    isOfficial(installationId) {
        const item = this.state.installations.find((entry) => entry.installationId === installationId);
        return modelAccessOrigin(item?.trustSource) === 'official';
    }
    originOf(item) {
        return modelAccessOrigin(item.trustSource);
    }
    /** Read-only snapshot directory of the running (or staged) version. */
    snapshotDirectory(item) {
        const digest = item.activeDigest ?? item.pendingDigest;
        return digest ? modelAccessSnapshotPath(this.options.root, digest) : undefined;
    }
    /** Display trust source of the running (or staged) version; persisted value is unchanged. */
    trustSourceOf(item) {
        if (item.trustSource !== 'bundled')
            return item.trustSource;
        const digest = item.activeDigest ?? item.pendingDigest;
        const mapping = this.remoteDelivery().digests.find((entry) => entry.localDigest === digest);
        return mapping?.origin === 'remote' ? 'official' : 'bundled';
    }
    /** Imports each old slot without replacing a newer file record; failed migrations retain it. */
    async migrateFileRecords() {
        if (!this.fileRecords)
            return;
        await migrateOsSlots(this.fileRecords, this.repository, this.state.credentials?.bindings ?? [], this.options.profileId);
        this.state = { ...this.state, credentials: this.fileRecords.state() };
    }
    list() {
        this.assertReady();
        this.refreshShared();
        return structuredClone(this.state.installations);
    }
    async restoreInstallation(installationId) {
        // Master switch off: nothing starts; the desired state is restored when it turns back on.
        if (this.remotePolicy.serviceDisabled())
            return;
        try {
            if (this.options.executionMode === 'subprocess')
                await this.subprocess.activate(installationId);
            else
                await this.enqueue(() => this.activate(installationId));
        }
        catch (error) {
            await this.enqueue(() => this.put({ ...this.item(installationId), ...failureState(error) }));
        }
    }
    credentialStatus() {
        this.assertReady();
        this.refreshShared();
        return {
            ownedBindings: this.state.credentials?.bindings.filter((binding) => binding.kind === 'direct-owned')
                .length ?? 0,
        };
    }
    preview(source) {
        this.assertReady();
        return previewLocalModelAccessPackage(source);
    }
    selectProvider(providerId, installationId) {
        return this.serial(async () => {
            const registration = this.mutableRegistry.get(installationId);
            if (!registration?.manifest.providers.some((provider) => provider.id === providerId))
                throw new ModelAccessPackageError('installation_missing');
            const providerSelections = [
                ...this.mutableRegistry
                    .selections()
                    .filter((selection) => selection.providerId !== providerId),
                { providerId, installationId },
            ];
            const next = { ...this.state, providerSelections };
            await this.commitState(next);
            this.loginService.invalidateProvider(providerId);
            this.requestService.invalidateProvider(providerId);
            this.mutableRegistry.selectProvider(providerId, installationId);
        });
    }
    /**
     * The server withdrew this extension provider: the master switch is off, or remote policy
     * removed the provider. Unlike a missing sign-in the user cannot fix it, so its configured
     * providers are hidden and Session / default references move to another model.
     */
    withdrawn(extensionProviderId, installationId) {
        this.refreshShared();
        return remoteWithdrawn(this.remotePolicy, extensionProviderId, installationId);
    }
    /** UI/model-system view of the same decision the request path enforces. */
    subscriptionAllowed(providerKey) {
        this.refreshShared();
        const binding = this.bindingService.peek(providerKey);
        const installed = binding
            ? this.state.installations.find((item) => item.installationId === binding.installationId)
            : undefined;
        if (installed && !installed.enabled)
            return false;
        if (binding && this.remoteRequestBlock(binding))
            return false;
        return this.capabilityPolicy.subscriptionsEnabled() || binding?.kind === 'public';
    }
    remoteRequestBlock(binding) {
        return remoteRequestBlock(this.remotePolicy, (id) => this.isOfficial(id), binding);
    }
    setSubscriptionsEnabled(enabled) {
        return this.updatePolicy((policy) => policy.setSubscriptionsEnabled(enabled));
    }
    setGlobal(capability, enabled) {
        return this.updatePolicy((policy) => policy.setGlobal(capability, enabled));
    }
    setTarget(target, enabled) {
        const captured = Object.freeze({ ...target });
        return this.updatePolicy((policy) => policy.setTarget(captured, enabled));
    }
    migrationListeners = new Set();
    /** Provider keys whose bindings official delivery moved to another installation. */
    onCredentialsMigrated(listener) {
        this.migrationListeners.add(listener);
        return () => this.migrationListeners.delete(listener);
    }
    /**
     * Official delivery split a package: bindings of `providerIds` move from the `from` package to
     * the active `to` package, with the user's switches of the sources the new package declares.
     * A binding the new package cannot take keeps its installation (the old package is kept).
     */
    async migrateCredentials(input) {
        const result = await this.serial(() => migrateInstallationCredentials({
            installations: () => this.state.installations,
            manifestOf: (id) => this.mutableRegistry.get(id)?.manifest,
            isOfficial: (id) => this.isOfficial(id),
            credentials: () => this.credentialState(),
            preferences: () => this.capabilityPolicy.preferences(),
            commit: async (before, credentials, preferences) => {
                if (this.fileRecords)
                    await this.fileRecords.save(before, credentials);
                await this.commitState({
                    ...this.state,
                    preferences,
                    ...(this.fileRecords ? {} : { credentials }),
                });
                if (this.fileRecords)
                    this.state = { ...this.state, credentials };
                this.capabilityPolicy.sync(preferences);
            },
            invalidate: (providerId, installationId) => this.requestService.invalidateProvider(providerId, installationId),
        }, input));
        if (result.moved.length)
            for (const listener of [...this.migrationListeners])
                listener(result.moved);
        return result;
    }
    updatePolicy(change) {
        return this.serial(async () => {
            const draft = new ModelAccessCapabilityPolicy(this.options.profileId, this.mutableRegistry, this.capabilityPolicy.preferences(), this.remotePolicy);
            change(draft);
            const preferences = draft.preferences();
            const next = { ...this.state, preferences };
            await this.commitState(next);
            change(this.capabilityPolicy);
            return preferences;
        });
    }
    /**
     * User packages: folder/zip installs and skill dev sessions, under exact-content consent. They
     * run in the user/dev host groups and are never governed by official catalog rules.
     */
    userPackages = new ModelAccessUserPackages({
        root: () => this.options.root,
        assertReady: () => this.assertReady(),
        list: () => this.state.installations,
        register: (source, digest, trustSource) => this.register(source, digest, trustSource),
        enable: (installationId) => this.enable(installationId),
        uninstall: (installationId) => this.uninstall(installationId),
        retag: (installationId, trustSource, digest) => this.serial(async () => {
            await this.put(retaggedInstallation(this.item(installationId), trustSource, digest));
            return structuredClone(this.item(installationId));
        }),
        restart: async (installationId) => {
            if (this.options.executionMode === 'subprocess')
                await this.subprocess.restart(installationId);
        },
        userPackagesAllowed: () => !this.remotePolicy.serviceDisabled(),
    });
    /**
     * Development-build import kept for existing callers: a local folder trusted by exact-content
     * consent, registered as a user package.
     */
    importLocal(request) {
        if (!isDevelopmentBuild())
            return Promise.reject(new ModelAccessPackageError('import_disabled'));
        const input = Object.freeze({ ...request });
        if (input.trustNativeCode !== true)
            return Promise.reject(new ModelAccessPackageError('trust_required'));
        return this.register(input.source, input.expectedDigest, 'dev-import');
    }
    /** Snapshots exact content and registers (or stages) it under the given trust source. */
    async register(source, expectedDigest, trustSource) {
        const input = Object.freeze({ source, expectedDigest });
        const registered = await this.mutatePackage(async () => {
            const preview = await snapshotLocalModelAccessPackage(this.options.root, input.source, input.expectedDigest);
            assertRegistrable(preview.manifest, trustSource, this.options);
            const previous = this.state.installations.find((item) => item.name === preview.manifest.name);
            // A user package never replaces an official installation of the same name, or vice versa.
            if (previous && isUserTrust(previous.trustSource) !== isUserTrust(trustSource))
                throw new ModelAccessPackageError('package_name_taken');
            if (previous) {
                if (unchangedRegistration(previous, preview.digest, trustSource))
                    return structuredClone(previous);
                const next = restagedInstallation(previous, preview.digest, trustSource);
                if (this.options.executionMode === 'subprocess') {
                    const staged = {
                        ...next,
                        generation: previous.generation,
                        status: previous.status,
                    };
                    await this.put(staged);
                    return structuredClone(staged);
                }
                // Closing admission is conservative if persistence fails; never leave old work runnable.
                await this.stop(previous.installationId);
                await this.put(next);
                return structuredClone(next);
            }
            if (this.state.installations.length >= 128)
                throw new ModelAccessPackageError('invalid_package');
            const next = newInstallation(preview.manifest.name, preview.digest, trustSource);
            await this.put(next);
            return structuredClone(next);
        });
        if (this.options.executionMode === 'subprocess' && registered.enabled) {
            await this.subprocess.activate(registered.installationId);
            return structuredClone(this.item(registered.installationId));
        }
        return registered;
    }
    enable(installationId) {
        if (this.options.executionMode === 'subprocess')
            return this.enableSubprocess(installationId);
        return this.serial(async () => {
            const previous = this.item(installationId);
            if (this.mutableRegistry.get(installationId))
                return structuredClone(previous);
            await this.put({ ...previous, enabled: true });
            try {
                await this.activate(installationId);
            }
            catch (error) {
                await this.put({ ...this.item(installationId), ...failureState(error) });
            }
            return structuredClone(this.item(installationId));
        });
    }
    /** User action; an official package is refused while remote delivery owns it. */
    async disable(installationId) {
        this.assertUserManaged(installationId);
        return this.disablePackage(installationId);
    }
    disablePackage(installationId) {
        return this.mutatePackage(async () => {
            const previous = this.item(installationId);
            await this.stop(installationId);
            const next = {
                ...previous,
                enabled: false,
                generation: previous.generation + 1,
                status: 'disabled',
                errorCode: undefined,
            };
            await this.put(next);
            return structuredClone(next);
        });
    }
    rollback(installationId, digest) {
        if (this.options.executionMode === 'subprocess')
            return this.rollbackSubprocess(installationId, digest);
        return this.mutatePackage(async () => {
            const item = this.item(installationId);
            if (!item.trustedDigests.includes(digest))
                throw new ModelAccessPackageError('trust_required');
            await this.validateActivatable(installationId, digest);
            await this.stop(installationId);
            const next = {
                ...item,
                pendingDigest: digest,
                generation: item.generation + 1,
                status: 'pending-restart',
                errorCode: undefined,
            };
            await this.put(next);
            return structuredClone(next);
        });
    }
    /**
     * Removes the installation and its own data directory. Other applications' credentials and
     * client directories are never touched.
     */
    async uninstall(installationId) {
        this.assertUserManaged(installationId);
        if (this.options.executionMode === 'subprocess') {
            await this.disablePackage(installationId);
            await this.serial(async () => {
                const item = this.item(installationId);
                if (item.enabled)
                    throw new ModelAccessPackageError('activation_failed');
                const draft = new ModelAccessCapabilityPolicy(this.options.profileId, this.mutableRegistry, this.capabilityPolicy.preferences());
                draft.disableBorrowSources(installationId);
                const next = {
                    ...this.state,
                    preferences: draft.preferences(),
                    installations: this.state.installations.filter((entry) => entry.installationId !== installationId),
                };
                await this.commitState(next);
                this.capabilityPolicy.disableBorrowSources(installationId);
                if (!(await this.repository.hasOtherOwners()))
                    await this.housekeeping.removeDataDir(installationId);
            });
            return;
        }
        await this.mutatePackage(async () => {
            this.item(installationId);
            await this.stop(installationId);
            const draft = new ModelAccessCapabilityPolicy(this.options.profileId, this.mutableRegistry, this.capabilityPolicy.preferences());
            draft.disableBorrowSources(installationId);
            const next = {
                ...this.state,
                preferences: draft.preferences(),
                installations: this.state.installations.filter((item) => item.installationId !== installationId),
            };
            await this.commitState(next);
            this.capabilityPolicy.disableBorrowSources(installationId);
        });
        // After the extension's disposal settled (mutatePackage waits for it): its processes no
        // longer hold or rewrite the directory.
        await this.serial(async () => {
            if (!(await this.repository.hasOtherOwners()))
                await this.housekeeping.removeDataDir(installationId);
        });
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.keepAlive?.close();
        this.requestService.close();
        this.borrowService.close();
        this.apiScanService.close();
        this.capabilityPolicy.close();
        await this.loginService.close();
        await this.tail;
        if (this.options.executionMode !== 'subprocess')
            await this.bindingService.drain();
        for (const item of this.mutableRegistry.list())
            await this.stop(item.installationId);
        await this.subprocess.close();
        await this.confirmProcessStops();
        if (this.options.executionMode === 'subprocess')
            await this.bindingService.drain();
        await this.releaseOwnership();
    }
    async releaseOwnership() {
        // A timed-out native write is not cancelled. Retain the process lock until it settles.
        await settleWithin(async () => {
            await this.bindingService.settled();
            await this.borrowService.settled();
            await this.requestService.settled();
            await this.apiScanService.settled();
            await this.inProcess.settled();
            await this.repository.close();
        }, this.options.disposeTimeoutMs ?? 5_000);
    }
    async saveCredentials(credentials, disableBorrow, expected, beforeCommit) {
        if (this.fileRecords) {
            await this.fileRecords.save(expected ?? this.fileRecords.state(), credentials, beforeCommit);
            this.state = { ...this.state, credentials };
            return;
        }
        const sourceIds = disableBorrow ? await this.borrowSourcesForAgent(disableBorrow) : [];
        const change = (policy) => {
            if (disableBorrow)
                policy.disableBorrowSources(disableBorrow.installationId, sourceIds);
        };
        const draft = new ModelAccessCapabilityPolicy(this.options.profileId, this.mutableRegistry, this.capabilityPolicy.preferences());
        change(draft);
        const next = {
            ...this.state,
            credentials,
            ...(disableBorrow ? { preferences: draft.preferences() } : {}),
        };
        await this.repository.write(next, beforeCommit);
        this.state = next;
        // Only after the pointer commit: invalidate borrow leases, never unrelated login/API leases.
        change(this.capabilityPolicy);
    }
    borrowSourcesForAgent(input) {
        return borrowSourcesOfAgent(input, {
            manifest: this.mutableRegistry.get(input.installationId)?.manifest,
            installation: this.state.installations.find((item) => item.installationId === input.installationId),
            validate: (digest) => this.validateSnapshot(input.installationId, digest),
        });
    }
    async enableSubprocess(installationId) {
        await this.serial(async () => {
            const item = this.item(installationId);
            if (!item.enabled)
                await this.put({ ...item, enabled: true });
        });
        await this.subprocess.activate(installationId);
        return structuredClone(this.item(installationId));
    }
    async rollbackSubprocess(installationId, digest) {
        await this.serial(async () => {
            const item = this.item(installationId);
            if (!item.trustedDigests.includes(digest))
                throw new ModelAccessPackageError('trust_required');
            await this.validateActivatable(installationId, digest);
            await this.put({ ...item, pendingDigest: digest, errorCode: undefined });
        });
        if (this.item(installationId).enabled)
            await this.subprocess.activate(installationId);
        return structuredClone(this.item(installationId));
    }
    async activate(installationId) {
        if (this.remotePolicy.serviceDisabled())
            throw new ModelAccessPackageError('service_disabled');
        const item = this.item(installationId);
        const digest = trustedActivationDigest(item);
        const { preview, directory } = await this.validateActivatable(installationId, digest);
        await this.housekeeping.ensureDataDir(installationId);
        const moduleUrl = pathToFileURL(path.join(directory, preview.manifest.entry)).href;
        this.inProcess.claim(installationId, moduleUrl);
        let extension;
        try {
            extension = await this.inProcess.load(moduleUrl, preview.manifest);
            // A change observed during module loading invalidates activation as well.
            if ((await previewLocalModelAccessPackage(directory)).digest !== digest)
                throw new ModelAccessPackageError('integrity_failed');
            if (this.closed)
                throw new ModelAccessPackageError('service_closed');
            const next = {
                ...item,
                activeDigest: digest,
                pendingDigest: undefined,
                generation: item.generation + 1,
                enabled: true,
                status: 'active',
                errorCode: undefined,
            };
            await this.put(next);
            if (this.closed)
                throw new ModelAccessPackageError('service_closed');
            // No await between committed pointer and publication. The exact contract was validated above.
            this.mutableRegistry.register({
                installationId,
                generation: next.generation,
                digest,
                manifest: preview.manifest,
                extension,
            });
        }
        catch (error) {
            this.mutableRegistry.remove(installationId);
            if (extension)
                await this.inProcess.dispose(extension);
            if (error instanceof ModelAccessPackageError)
                throw error;
            throw new ModelAccessPackageError('activation_failed');
        }
    }
    validateSnapshot(installationId, digest) {
        return validateModelAccessSnapshot(this.options, this.item(installationId), digest, this.state.credentials);
    }
    assertCredentialInstallation(input, kind, credentialSchema) {
        this.assertReady();
        this.refreshShared();
        if (this.fileRecords &&
            !this.state.installations.some((item) => item.installationId === input.installationId && item.enabled))
            throw new ModelAccessPackageError('installation_missing');
        const registration = this.mutableRegistry.providerOf(input.installationId, input.providerId)?.registration;
        const desired = this.state.installations.find((item) => item.installationId === input.installationId);
        if (this.fileRecords && desired?.activeDigest !== registration?.digest)
            throw new ModelAccessPackageError('package_changed');
        const provider = registration?.manifest.providers.find((item) => item.id === input.providerId);
        if (!registration || registration.installationId !== input.installationId)
            throw new ModelAccessPackageError('installation_missing');
        if (!provider?.credentialKinds.includes(kind) ||
            (credentialSchema !== undefined && provider.credentialSchema !== credentialSchema)) {
            throw new ModelAccessPackageError('credential_schema_mismatch');
        }
        return registration.generation;
    }
    /** Aborts every in-flight operation of the installation, then disposes the extension. */
    async stop(installationId) {
        // Policy leases carry login/borrow/api-scan signals: revoking them aborts those first.
        this.capabilityPolicy.invalidateInstallation(installationId);
        const requestsSettled = (async () => {
            await Promise.all([
                this.requestService.invalidateInstallation(installationId),
                this.apiScanService.invalidateInstallation(installationId),
            ]);
        })();
        const registration = this.mutableRegistry.remove(installationId);
        if (this.options.executionMode === 'subprocess') {
            observeModelAccessWork(requestsSettled);
            const stopping = this.subprocess.deactivate(installationId);
            this.processStops.add(stopping);
            observeModelAccessWork(stopping);
        }
        else if (registration)
            this.inProcess.queue(registration.extension, requestsSettled);
    }
    /** Commit/revoke in the write lane, then wait outside it: CLI cleanup persists on that lane too. */
    async mutatePackage(operation) {
        try {
            return await this.serial(operation);
        }
        finally {
            if (this.options.executionMode === 'subprocess')
                await this.confirmProcessStops();
            else
                await this.inProcess.waitAll();
        }
    }
    async confirmProcessStops() {
        const pending = [...this.processStops];
        const results = await Promise.allSettled(pending);
        for (let index = 0; index < results.length; index++)
            this.processStops.delete(pending[index]);
        if (results.some((result) => result.status === 'rejected'))
            throw new ModelAccessPackageError('host_exit_unconfirmed');
    }
    credentialState() {
        return this.fileRecords?.state() ?? this.state.credentials ?? { bindings: [] };
    }
    item(installationId) {
        const item = this.state.installations.find((candidate) => candidate.installationId === installationId);
        if (!item)
            throw new ModelAccessPackageError('installation_missing');
        return item;
    }
    async put(item) {
        const next = {
            ...this.state,
            installations: [
                ...this.state.installations.filter((entry) => entry.installationId !== item.installationId),
                item,
            ],
        };
        await this.commitState(next);
    }
    /** Persist `next` (shared file records keep their own credentials) and adopt it. */
    async commitState(next) {
        await this.repository.write(this.fileRecords ? { ...next, credentials: this.legacyCredentialState } : next);
        this.state = next;
    }
    serial(operation) {
        this.assertReady();
        return this.enqueue(async () => {
            this.assertReady();
            return operation();
        });
    }
    /** Retained marker fences may clear after public admission closes, but still share the write lane. */
    enqueue(operation) {
        const preceding = this.tail;
        const result = (async () => {
            await preceding;
            return this.repository.transaction(async () => {
                this.refreshShared();
                return operation();
            });
        })();
        this.tail = settleQuietly(result);
        return result;
    }
    assertReady() {
        if (this.closed || !this.ready)
            throw new ModelAccessPackageError('service_closed');
    }
}
//# sourceMappingURL=package-lifecycle.service.js.map