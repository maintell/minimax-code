import { ModelAccessPolicyError } from '../../service/model-access-extension/index.js';
import { generateProviderKey, importModelAccessApi, parseProviderId, } from '../../service/model-system/index.js';
import { AppError } from '../errors.js';
import { safeErrorCode, toModelAccessAppError } from './model-access-errors.js';
import { devSessionInfo, ModelAccessUserPackageOperations, packagePresentation, packageSourceInput, } from './model-access-user-packages.js';
const CAPABILITIES = new Set(['login', 'subscriptionBorrow', 'apiKeyScan']);
const TERMINAL_LOGIN_STATES = new Set([
    'completed',
    'cancelled',
    'expired',
    'failed',
]);
const MAX_PENDING_LOGINS = 128;
const MAX_IMPORT_CANDIDATES = 100;
function failoverInfo(view) {
    const member = (item) => ({
        providerId: item.providerId,
        name: item.name,
        state: item.state,
        ...(item.accountMasked ? { accountMasked: item.accountMasked } : {}),
        ...(item.retryAt !== undefined ? { retryAt: item.retryAt } : {}),
        ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
        ...(item.bindingKind ? { bindingKind: item.bindingKind } : {}),
    });
    return {
        supported: view.supported,
        enabled: view.enabled,
        backups: view.backups.map(member),
        candidates: view.candidates.map(member),
        ...(view.selected ? { selected: [...view.selected] } : {}),
    };
}
async function run(operation) {
    try {
        return await operation();
    }
    catch (error) {
        throw toModelAccessAppError(error);
    }
}
function invalidRequest() {
    return new AppError(400, 'VALIDATION_ERROR', 'Invalid model access request');
}
function text(value, maximum = 256) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        /[\u0000-\u001f]/u.test(value)) {
        throw invalidRequest();
    }
    return value;
}
function optionalText(value) {
    return value === undefined || value === '' ? undefined : text(value);
}
function flag(value) {
    if (typeof value !== 'boolean')
        throw invalidRequest();
    return value;
}
function capability(value) {
    if (typeof value !== 'string' || !CAPABILITIES.has(value))
        throw invalidRequest();
    return value;
}
function signalOrNever(signal) {
    return signal ?? new AbortController().signal;
}
function defaultProviderName(providerId) {
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}
function sameTarget(left, right) {
    return (left.installationId === right.installationId &&
        left.sourceId === right.sourceId &&
        left.capability === right.capability &&
        left.entryId === right.entryId &&
        left.target === right.target);
}
function sourceInfo(source, states) {
    const entries = [];
    for (const method of source.capabilities.login?.methods ?? []) {
        entries.push({
            capability: 'login',
            entryId: method.id,
            kind: method.kind,
            targets: states(source.id, 'login', method.id, method.targets),
        });
    }
    for (const variant of source.capabilities.subscriptionBorrow?.variants ?? []) {
        entries.push({
            capability: 'subscriptionBorrow',
            entryId: variant.id,
            targets: states(source.id, 'subscriptionBorrow', variant.id, variant.targets),
        });
    }
    for (const reader of source.capabilities.apiKeyScan?.readers ?? []) {
        entries.push({
            capability: 'apiKeyScan',
            entryId: reader.id,
            targets: states(source.id, 'apiKeyScan', reader.id, reader.targets),
        });
    }
    return { sourceId: source.id, hostAgentId: source.hostAgentId, entries };
}
function manifestProviders(manifest) {
    return manifest.providers.map((provider) => ({
        providerId: provider.id,
        credentialKinds: [...provider.credentialKinds],
    }));
}
function loginView(view) {
    switch (view.kind) {
        case 'browser':
            return { kind: 'browser', url: view.url };
        case 'device':
            return {
                kind: 'device',
                verificationUrl: view.verificationUrl,
                userCode: view.userCode,
                expiresAt: view.expiresAt,
            };
        case 'secret-form':
            return { kind: 'secret-form', fields: view.fields.map(({ id, label }) => ({ id, label })) };
        case 'cli':
            return { kind: 'cli', message: view.message };
    }
}
function loginInfo(status) {
    return {
        flowId: status.flowId,
        providerId: `custom_provider:${status.providerKey}`,
        state: status.state,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
        ...(status.view ? { view: loginView(status.view) } : {}),
        ...(status.errorCode ? { errorCode: status.errorCode } : {}),
        cleanup: status.cleanup,
    };
}
function apiCandidate(view) {
    return {
        candidateId: view.candidateId,
        installationId: view.installationId,
        sourceId: view.sourceId,
        readerId: view.readerId,
        target: view.target,
        upstream: view.upstream,
        endpointOrigin: view.endpointOrigin,
        api: view.api,
        modelCount: view.modelCount,
    };
}
function remoteState(view) {
    return {
        enabled: view.enabled,
        serviceEnabled: view.serviceEnabled,
        ...(view.switchSource ? { switchSource: view.switchSource } : {}),
        ...(view.environment ? { environment: view.environment } : {}),
        ...(view.sequence !== undefined ? { sequence: view.sequence } : {}),
        ...(view.lastSuccessAtMs !== undefined ? { lastSuccessAtMs: view.lastSuccessAtMs } : {}),
        ...(view.lastErrorCode ? { lastErrorCode: view.lastErrorCode } : {}),
        ...(view.nextRetryAtMs !== undefined ? { nextRetryAtMs: view.nextRetryAtMs } : {}),
        capabilityRules: view.capabilityRules.map((rule) => ({ ...rule })),
        providerRules: view.providerRules.map((rule) => ({ ...rule })),
        providers: view.providers.map(remotePresentation),
        sources: view.sources.map(remotePresentation),
    };
}
function remotePresentation(view) {
    return {
        ...view,
        entries: view.entries?.map((entry) => ({ ...entry, displayName: { ...entry.displayName } })),
    };
}
function usageInfo(view) {
    return {
        status: view.status,
        queriedAt: view.queriedAt,
        identityRevision: view.identityRevision,
        ...(view.plan ? { plan: view.plan } : {}),
        ...(view.expiryStatus ? { expiryStatus: view.expiryStatus } : {}),
        // Missing `used` stays missing: unknown quota must never render as 0.
        windows: view.windows.map((window) => ({
            name: window.name,
            unit: window.unit,
            ...(window.used !== undefined ? { used: window.used } : {}),
            ...(window.amount !== undefined ? { amount: window.amount } : {}),
            ...(window.limit !== undefined ? { limit: window.limit } : {}),
            ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
            ...(window.runsOutAt !== undefined ? { runsOutAt: window.runsOutAt } : {}),
        })),
    };
}
export class ModelAccessApplication {
    deps;
    pending = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async snapshot() {
        return run(async () => {
            await this.deps.packages.synchronize();
            return this.project();
        });
    }
    /** Developer Tools status; `available: false` for owners without delivery. */
    deliveryStatus() {
        return (this.deps.delivery?.status() ?? { available: false, enabled: false, switchSource: 'default' });
    }
    /** Developer Tools "sync now"; resolves with the committed snapshot after the sync settles. */
    async syncDelivery() {
        const delivery = this.deps.delivery;
        if (!delivery)
            throw new AppError(404, 'MODEL_ACCESS_DELIVERY_UNAVAILABLE', 'unavailable');
        return this.mutate(() => delivery.syncNow());
    }
    async setDeliveryOptIn(enabled) {
        const delivery = this.deps.delivery;
        if (!delivery)
            throw new AppError(404, 'MODEL_ACCESS_DELIVERY_UNAVAILABLE', 'unavailable');
        const value = flag(enabled);
        return this.mutate(() => delivery.setOptIn(value));
    }
    async preview(source, sourceRef) {
        const input = packageSourceInput(source, sourceRef);
        return run(async () => {
            const user = this.deps.packages.userPackages;
            const preview = user
                ? await user.preview(input)
                : await this.deps.packages.preview(text(source, 4096));
            const disabled = (_sourceId, _capability, _entryId, targets) => targets.map((target) => ({ target, enabled: false }));
            return {
                digest: preview.digest,
                name: preview.manifest.name,
                version: preview.manifest.version,
                fileCount: preview.fileCount,
                byteCount: preview.byteCount,
                platforms: [...preview.manifest.platforms],
                providers: manifestProviders(preview.manifest),
                sources: preview.manifest.sources.map((item) => sourceInfo(item, disabled)),
            };
        });
    }
    async importPackage(req) {
        const source = packageSourceInput(req.source, req.sourceRef);
        const expectedDigest = text(req.expectedDigest);
        const trustNativeCode = flag(req.trustNativeCode);
        const user = this.deps.packages.userPackages;
        if (user)
            return this.mutate(() => user.install({ source, expectedDigest, trustNativeCode }));
        return this.mutate(() => this.deps.packages.importLocal({
            source: text(req.source, 4096),
            expectedDigest,
            trustNativeCode,
        }));
    }
    /** Dev sessions, promotion, status and export (user packages). */
    get userPackages() {
        return new ModelAccessUserPackageOperations({
            packages: this.deps.packages,
            mutate: (operation) => this.mutate(operation),
            project: () => this.project(),
        });
    }
    async enable(installationId) {
        const id = text(installationId);
        return this.mutate(() => this.deps.packages.enable(id));
    }
    async disable(installationId) {
        const id = text(installationId);
        return this.mutate(() => this.deps.packages.disable(id));
    }
    async rollback(req) {
        const id = text(req.installationId);
        const digest = text(req.digest);
        return this.mutate(() => this.deps.packages.rollback(id, digest));
    }
    async uninstall(installationId) {
        const id = text(installationId);
        return this.mutate(() => this.deps.packages.uninstall(id));
    }
    async setGlobal(req) {
        if (req.capability === 'subscriptions')
            return this.mutate(() => this.deps.packages.setSubscriptionsEnabled(flag(req.enabled)));
        const target = capability(req.capability);
        const enabled = flag(req.enabled);
        return this.mutate(() => this.deps.packages.setGlobal(target, enabled));
    }
    async setTarget(req) {
        const target = {
            installationId: text(req.installationId),
            sourceId: text(req.sourceId),
            capability: capability(req.capability),
            entryId: text(req.entryId),
            target: text(req.target),
        };
        const enabled = flag(req.enabled);
        return this.mutate(() => this.deps.packages.setTarget(target, enabled));
    }
    /**
     * Explicit direct login. It never scans local subscriptions; the binding owner
     * replaces the provider's binding only after success and stops that Agent's borrow.
     * The flow outlives this HTTP request, so the request signal is not attached.
     */
    async beginLogin(req) {
        await this.deps.packages.synchronize();
        const installationId = text(req.installationId);
        const sourceId = text(req.sourceId);
        const methodId = text(req.methodId);
        const target = text(req.target);
        const providerId = text(req.providerId);
        const existingProviderId = optionalText(req.existingProviderId);
        const name = optionalText(req.name);
        return run(async () => {
            const { source } = this.activeSource(installationId, sourceId);
            const destination = this.providerDestination(existingProviderId, name, providerId);
            await this.ensureLoginTarget({
                installationId,
                sourceId,
                capability: 'login',
                entryId: methodId,
                target,
            });
            await this.reservePendingLogin();
            const status = await this.deps.packages.login.begin({
                installationId,
                sourceId,
                methodId,
                target,
                providerId,
                providerKey: destination.providerKey,
                explicitUserAction: true,
                dependenciesReady: this.deps.ready(),
            });
            this.pending.set(status.flowId, {
                providerKey: destination.providerKey,
                name: destination.name,
                hostAgentId: source.hostAgentId,
                committed: false,
            });
            return this.loginResult(status);
        });
    }
    async loginStatus(flowId) {
        const id = text(flowId);
        return run(async () => this.loginResult(await this.deps.packages.login.status(id)));
    }
    async submitLogin(req) {
        const id = text(req.flowId);
        const values = req.values;
        if (!values || typeof values !== 'object' || Array.isArray(values))
            throw invalidRequest();
        if (Object.values(values).some((value) => typeof value !== 'string'))
            throw invalidRequest();
        return run(async () => this.loginResult(await this.deps.packages.login.submit(id, { ...values })));
    }
    async cancelLogin(flowId) {
        const id = text(flowId);
        return run(async () => this.loginResult(await this.deps.packages.login.cancel(id)));
    }
    /** Reads only sources whose global and per-target borrow permission is on (closed sources: I/O 0). */
    async discoverBorrow(req, signal) {
        const installationId = optionalText(req.installationId);
        const sourceId = optionalText(req.sourceId);
        return run(async () => {
            const candidates = [];
            for (const { active, variant, target } of this.enabledBorrowTargets(installationId, sourceId)) {
                candidates.push(...(await this.discoverVariant(active, variant, target, signal)));
            }
            return candidates;
        });
    }
    /** Explicit "use local subscription"; an existing provider switches mode in place. */
    async useBorrow(req, signal) {
        const installationId = text(req.installationId);
        const sourceId = text(req.sourceId);
        const variant = text(req.variant);
        const target = text(req.target);
        const providerId = text(req.providerId);
        const existingProviderId = optionalText(req.existingProviderId);
        const name = optionalText(req.name);
        return run(async () => {
            const { source } = this.activeSource(installationId, sourceId);
            const destination = this.providerDestination(existingProviderId, name, providerId);
            const binding = await this.deps.packages.borrow.useCurrent({
                sourceRef: { installationId, sourceId, variant, target, selector: 'current' },
                providerKey: destination.providerKey,
                providerId,
                explicitUserAction: true,
                dependenciesReady: this.deps.ready(),
                ...(signal ? { signal } : {}),
            });
            // The account was already connected under another key: open that provider, add nothing.
            if (binding.providerKey !== destination.providerKey) {
                const connected = this.deps.providers
                    .listUserProviders()
                    .find((item) => item.providerId === `custom_provider:${binding.providerKey}`);
                if (connected)
                    return connected;
            }
            return this.deps.providers.upsertModelAccessProvider(binding.providerKey, { name: destination.name, hostAgentId: source.hostAgentId }, signal ? { modelAccess: { signal } } : undefined);
        });
    }
    /**
     * Enables a public service provider (manifest credentialKinds exactly ['public']): no login,
     * no account. An existing provider of the same extension provider switches to it in place.
     */
    async enablePublic(req, signal) {
        const installationId = text(req.installationId);
        const providerId = text(req.providerId);
        const existingProviderId = optionalText(req.existingProviderId);
        const name = optionalText(req.name);
        return run(async () => {
            const registration = this.deps.packages.registry.get(installationId);
            const provider = registration?.manifest.providers.find((item) => item.id === providerId);
            if (!registration || !provider)
                throw new AppError(404, 'MODEL_ACCESS_INSTALLATION_MISSING', 'installation_missing');
            if (provider.credentialKinds.length !== 1 || provider.credentialKinds[0] !== 'public')
                throw new AppError(400, 'MODEL_ACCESS_PROVIDER_NOT_PUBLIC', 'provider_not_public');
            const destination = this.providerDestination(existingProviderId, name, providerId);
            if (!this.deps.ready())
                throw new ModelAccessPolicyError('dependency_unavailable');
            const controller = new AbortController();
            // The binding owner checks the installation is still active and declares `public`.
            await this.deps.packages.bindings.replacePublic({
                providerKey: destination.providerKey,
                installationId,
                providerId,
                credentialSchema: provider.credentialSchema,
                signal: signal ?? controller.signal,
            });
            return this.deps.providers.upsertModelAccessProvider(destination.providerKey, 
            // A public service has no local application: its host agent is the provider itself.
            { name: destination.name, hostAgentId: providerId }, signal ? { modelAccess: { signal } } : undefined);
        });
    }
    /** Disables a public service provider: its binding and its model configuration are removed. */
    async disablePublic(req) {
        const providerId = text(req.providerId);
        return run(async () => {
            const parsed = parseProviderId(providerId);
            if (parsed?.source !== 'custom_provider')
                throw invalidRequest();
            const view = this.deps.providers
                .listUserProviders()
                .find((item) => item.providerId === parsed.providerId);
            if (!view)
                return false;
            const binding = this.deps.packages.bindings.peek(parsed.providerKey);
            if (view.modelAccess?.bindingKind !== 'public' || binding?.kind !== 'public')
                throw new AppError(400, 'MODEL_ACCESS_PROVIDER_NOT_PUBLIC', 'provider_not_public');
            await this.deps.providers.deleteUserProvider({ providerId: parsed.providerId });
            return true;
        });
    }
    /** Scans only enabled readers and targets; a disabled reader performs no source I/O. */
    async scanApi(req, signal) {
        const installationId = optionalText(req.installationId);
        const sourceId = optionalText(req.sourceId);
        const readerId = optionalText(req.readerId);
        return run(async () => {
            const failures = [];
            for (const active of this.activeSources(installationId, sourceId)) {
                for (const reader of active.source.capabilities.apiKeyScan?.readers ?? []) {
                    if (readerId !== undefined && reader.id !== readerId)
                        continue;
                    const targets = this.deps.packages.policy
                        .describe({
                        installationId: active.installationId,
                        sourceId: active.source.id,
                        capability: 'apiKeyScan',
                        entryId: reader.id,
                    })
                        .filter((state) => state.enabled)
                        .map((state) => state.target);
                    if (targets.length === 0)
                        continue;
                    try {
                        await this.deps.packages.apiScan.scan({
                            installationId: active.installationId,
                            sourceId: active.source.id,
                            readerId: reader.id,
                            targets,
                            signal: signalOrNever(signal),
                        });
                    }
                    catch (error) {
                        failures.push({
                            installationId: active.installationId,
                            sourceId: active.source.id,
                            readerId: reader.id,
                            errorCode: safeErrorCode(error),
                        });
                    }
                }
            }
            return {
                candidates: this.deps.packages.apiScan.list().map(apiCandidate),
                ...(failures.length ? { failures } : {}),
            };
        });
    }
    async listApiCandidates() {
        return run(() => ({ candidates: this.deps.packages.apiScan.list().map(apiCandidate) }));
    }
    /** The runtime rereads each candidate before commit; imports become ordinary BYOK. */
    async importApi(candidateIds, signal) {
        if (!Array.isArray(candidateIds) ||
            candidateIds.length === 0 ||
            candidateIds.length > MAX_IMPORT_CANDIDATES) {
            throw invalidRequest();
        }
        const ids = candidateIds.map((id) => text(id));
        return run(async () => {
            const results = [];
            for (const candidateId of ids) {
                try {
                    if (!this.deps.ready())
                        throw new ModelAccessPolicyError('dependency_unavailable');
                    const providerId = await importModelAccessApi(this.deps.packages.apiScan, this.deps.providers, { candidateId, signal: signalOrNever(signal) });
                    results.push({ candidateId, result: 'imported', providerId });
                }
                catch (error) {
                    const errorCode = safeErrorCode(error);
                    results.push({
                        candidateId,
                        result: errorCode === 'api_candidate_stale' ? 'stale' : 'failed',
                        errorCode,
                    });
                }
            }
            return { results };
        });
    }
    /** Backup accounts of a primary provider; public or unknown providers are not supported. */
    async getFailover(providerId) {
        const id = text(providerId);
        return run(() => failoverInfo(this.deps.providers.getModelAccessFailover(id)));
    }
    /** Stores the primary's pool after the member rules pass; errors carry a stable code. */
    async setFailover(req) {
        const providerId = text(req.providerId);
        if (typeof req.enabled !== 'boolean' || !Array.isArray(req.backups) || req.backups.length > 16)
            throw invalidRequest();
        const backups = req.backups.map((item) => text(item));
        if (req.members !== undefined && (!Array.isArray(req.members) || req.members.length > 6))
            throw invalidRequest();
        const members = Array.isArray(req.members) ? req.members.map((item) => text(item)) : undefined;
        return run(async () => failoverInfo(await this.deps.providers.setModelAccessFailover({
            providerId,
            enabled: req.enabled,
            backups,
            ...(members ? { members } : {}),
        })));
    }
    async queryUsage(providerId, signal) {
        const id = text(providerId);
        return run(async () => usageInfo(await this.deps.providers.queryModelAccessUsage(id, signal ? { modelAccess: { signal } } : undefined)));
    }
    async mutate(operation) {
        return run(async () => {
            await operation();
            return this.project();
        });
    }
    project() {
        const packages = this.deps.packages;
        const listed = packages.list();
        const preferences = packages.policy.preferences();
        const installations = listed.map((item) => {
            const registration = packages.registry.get(item.installationId);
            // Only active packages expose a runtime manifest; inactive ones never fake capabilities.
            const manifest = registration?.manifest;
            const states = (sourceId, capabilityId, entryId) => packages.policy
                .describe({
                installationId: item.installationId,
                sourceId,
                capability: capabilityId,
                entryId,
            })
                .map(({ target, enabled }) => {
                if (capabilityId !== 'login')
                    return { target, enabled };
                // An unconfigured login target follows the login global: beginning a login
                // records it as the explicit consent (see ensureLoginTarget).
                const recorded = preferences.targets.find((entry) => sameTarget(entry, {
                    installationId: item.installationId,
                    sourceId,
                    capability: 'login',
                    entryId,
                    target,
                }));
                const remoteAllowed = !packages.policy.remoteBlock('login', sourceId, {
                    entryId,
                    target,
                });
                return {
                    target,
                    enabled: recorded ? enabled : remoteAllowed && preferences.globals.login,
                };
            });
            const trustSource = packages.trustSourceOf?.(item) ?? item.trustSource;
            return {
                installationId: item.installationId,
                name: item.name,
                generation: item.generation,
                ...(item.activeDigest ? { activeDigest: item.activeDigest } : {}),
                ...(item.pendingDigest ? { pendingDigest: item.pendingDigest } : {}),
                enabled: item.enabled,
                trustedDigests: [...item.trustedDigests],
                status: item.status,
                ...(item.errorCode ? { errorCode: item.errorCode } : {}),
                ...(trustSource ? { trustSource } : {}),
                ...(packages.originOf ? { origin: packages.originOf(item) } : {}),
                ...(manifest && packages.originOf?.(item) !== 'official'
                    ? packagePresentation(manifest, packages.snapshotDirectory?.(item))
                    : {}),
                ...(manifest
                    ? {
                        version: manifest.version,
                        providers: manifestProviders(manifest),
                        sources: manifest.sources.map((source) => sourceInfo(source, states)),
                    }
                    : {}),
            };
        });
        const globals = preferences.globals;
        const credentials = packages.credentialStatus();
        return {
            ready: this.deps.ready(),
            subscriptionsEnabled: preferences.subscriptionsEnabled !== false,
            installations,
            globals: {
                login: globals.login,
                subscriptionBorrow: globals.subscriptionBorrow,
                apiKeyScan: globals.apiKeyScan,
            },
            credentials: {
                ownedBindings: credentials.ownedBindings,
            },
            ...(this.deps.packages.remoteView
                ? { remote: remoteState(this.deps.packages.remoteView(this.deliveryStatus())) }
                : {}),
            ...(packages.userPackages
                ? {
                    devSessions: packages.userPackages.sessionsList().map(devSessionInfo),
                    // Already the wire shape (cloned): id, kind, path, name, version, digest, time, session.
                    devRequests: [...packages.userPackages.requestsList()],
                }
                : {}),
        };
    }
    *activeSources(installationId, sourceId) {
        for (const registration of this.deps.packages.registry.list()) {
            if (installationId !== undefined && registration.installationId !== installationId)
                continue;
            for (const source of registration.manifest.sources) {
                if (sourceId !== undefined && source.id !== sourceId)
                    continue;
                yield { installationId: registration.installationId, source };
            }
        }
    }
    /** Borrow variant/target pairs whose per-target permission is on; closed targets are never yielded. */
    *enabledBorrowTargets(installationId, sourceId) {
        for (const active of this.activeSources(installationId, sourceId)) {
            for (const variant of active.source.capabilities.subscriptionBorrow?.variants ?? []) {
                const states = this.deps.packages.policy.describe({
                    installationId: active.installationId,
                    sourceId: active.source.id,
                    capability: 'subscriptionBorrow',
                    entryId: variant.id,
                });
                for (const state of states.filter((item) => item.enabled)) {
                    yield { active, variant: variant.id, target: state.target };
                }
            }
        }
    }
    activeSource(installationId, sourceId) {
        const source = this.deps.packages.registry
            .get(installationId)
            ?.manifest.sources.find((item) => item.id === sourceId);
        if (!source)
            throw new AppError(404, 'MODEL_ACCESS_INSTALLATION_MISSING', 'installation_missing');
        return { installationId, source };
    }
    async discoverVariant(active, variant, target, signal) {
        const base = {
            installationId: active.installationId,
            sourceId: active.source.id,
            hostAgentId: active.source.hostAgentId,
            variant,
            target,
        };
        try {
            const found = await this.deps.packages.borrow.discover({
                sourceRef: {
                    installationId: active.installationId,
                    sourceId: active.source.id,
                    variant,
                    target,
                    selector: 'current',
                },
                ...(signal ? { signal } : {}),
            });
            if (found.length === 0)
                return [{ ...base, status: 'unavailable' }];
            return found.map((item) => ({
                ...base,
                providerId: item.providerId,
                status: item.status,
                ...(item.accountMasked ? { accountMasked: item.accountMasked } : {}),
                ...(item.plan ? { plan: item.plan } : {}),
            }));
        }
        catch (error) {
            return [{ ...base, status: 'unknown', errorCode: safeErrorCode(error) }];
        }
    }
    /**
     * Chooses the providerKey for a login/borrow commit. An existing provider must be
     * extension-owned by the same canonical provider; ordinary BYOK/OAuth is never taken over.
     */
    providerDestination(existingProviderId, name, extensionProviderId) {
        const views = this.deps.providers.listUserProviders();
        if (existingProviderId !== undefined) {
            const parsed = parseProviderId(existingProviderId);
            if (parsed?.source !== 'custom_provider')
                throw invalidRequest();
            const view = views.find((item) => item.providerId === parsed.providerId);
            if (view && view.modelAccess?.providerId !== extensionProviderId) {
                throw new AppError(409, 'PROVIDER_CONFLICT', 'Provider is owned by another provider kind');
            }
            return {
                providerKey: parsed.providerKey,
                name: name ?? view?.name ?? defaultProviderName(extensionProviderId),
            };
        }
        const displayName = name ?? defaultProviderName(extensionProviderId);
        const existingKeys = [
            ...views.flatMap((item) => parseProviderId(item.providerId)?.providerKey ?? []),
            ...[...this.pending.values()].map((item) => item.providerKey),
        ];
        return { providerKey: generateProviderKey({ displayName, existingKeys }), name: displayName };
    }
    /**
     * Login targets are policy-gated like every capability. Clicking login is the explicit
     * consent for a target the user never configured; an explicit "off" is respected.
     */
    async ensureLoginTarget(target) {
        const preferences = this.deps.packages.policy.preferences();
        if (!preferences.globals.login)
            return;
        if (preferences.targets.some((item) => sameTarget(item, target)))
            return;
        await this.deps.packages.setTarget(target, true);
    }
    async reservePendingLogin() {
        if (this.pending.size < MAX_PENDING_LOGINS)
            return;
        for (const [flowId, item] of this.pending) {
            if (item.committed) {
                this.pending.delete(flowId);
                continue;
            }
            try {
                const status = await this.deps.packages.login.status(flowId);
                if (TERMINAL_LOGIN_STATES.has(status.state) && status.state !== 'completed') {
                    this.pending.delete(flowId);
                }
            }
            catch {
                this.pending.delete(flowId);
            }
        }
        if (this.pending.size >= MAX_PENDING_LOGINS) {
            throw new AppError(409, 'MODEL_ACCESS_LOGIN_BUSY', 'login_busy');
        }
    }
    /** Commits the provider entry once the binding is committed; a failed commit retries on poll. */
    async loginResult(status) {
        const login = loginInfo(status);
        const pending = this.pending.get(status.flowId);
        if (!pending)
            return { login };
        if (status.state !== 'completed') {
            if (TERMINAL_LOGIN_STATES.has(status.state))
                this.pending.delete(status.flowId);
            return { login };
        }
        // Signing in again to an account already connected commits into that account's own key.
        const providerKey = status.binding?.providerKey ?? pending.providerKey;
        try {
            const current = pending.committed
                ? this.deps.providers
                    .listUserProviders()
                    .find((item) => item.providerId === `custom_provider:${providerKey}`)
                : undefined;
            if (current)
                return { login, provider: current };
            // Concurrent status/submit requests must not reset display defaults more than once.
            pending.committing ??= this.commitLoginProvider(pending, providerKey);
            const provider = await pending.committing;
            pending.committed = true;
            return { login, provider };
        }
        catch (error) {
            return { login: { ...login, providerErrorCode: safeErrorCode(error) } };
        }
    }
    async commitLoginProvider(pending, providerKey) {
        try {
            const provider = await this.deps.providers.upsertModelAccessProvider(providerKey, {
                name: pending.name,
                hostAgentId: pending.hostAgentId,
            });
            pending.committed = true;
            return provider;
        }
        finally {
            pending.committing = undefined;
        }
    }
}
//# sourceMappingURL=model-access-application.js.map