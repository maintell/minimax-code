import path from 'node:path';
import { EMPTY_CONNECTOR_RUNTIME } from './app/runtime.js';
import { PluginSystemError } from './errors.js';
import { PluginSystemMetrics } from './metrics.js';
import { PluginCapabilityGenerationRegistry } from './mcp/generation-registry.js';
import { PluginMcpRuntime } from './mcp/runtime.js';
import { PluginMiniAppPublicationController } from './plugin/runtime/miniapp/controller.js';
import { prepareMiniAppTurn } from './plugin/runtime/miniapp/turn-preparation.js';
import { deferred, assertOfficialMutationScope, assertPluginNameAvailable, revokeOfficialPluginSelection, assertPluginSystemPublicationAttached, capturePluginSystemTurnCapabilities, findLocalPlugin, ignoreFailure, normalizedPluginName, preparePluginSystemTurnCapabilities, runAfter, scopeKey, resolvePluginRepositoryScope, settleInBackground, waitForScopedOperation, } from './plugin-system-helpers.js';
import { LocalPluginDirectoryWatcher, } from './plugin/runtime/local-directory-watcher.js';
import { MarketplacePreviewCache, PluginMarketplacePreview, } from './plugin/runtime/marketplace-preview.js';
import { decidePreparedOfficialSync, handleIncompleteOfficialSync, OfficialPluginRecovery, prepareOfficialFullState, prepareOfficialMutation, waitForOfficialPublication, } from './plugin/runtime/official-operations.js';
import { buildCustomOnlySnapshot, localSnapshotInventory, readPluginSnapshotInputs, removedPluginHookNames, } from './plugin/runtime/snapshot-inputs.js';
import { PluginPackageStorage, } from './plugin/runtime/package-storage.js';
import { materializeOfficialPluginArchive, } from './plugin/package/archive-cache.js';
import { PluginSnapshotBuilder, EMPTY_PLUGIN_SNAPSHOT, withPluginMcpRuntime, withPluginSnapshotRevision, } from './plugin/runtime/snapshot-builder.js';
import { assertPluginPublicationFence, completePluginPublication, commitPreparedPluginPublication, isPublicationSuperseded, officialPublicationOptions, preparePluginPublication, recoverDestructivePluginPublication, throwRecoveredDestructivePublicationFailure, preparedPluginPublicationFinalizer, PluginMcpDiscoveryScheduler, rollbackPreparedPluginPublication, sameLocalPluginProjection, } from './publication.js';
export class PluginSystem {
    options;
    builder;
    initialization = deferred();
    initializeStarted = false;
    initializationTask;
    operationTail = Promise.resolve();
    publicationPort;
    pendingPublication;
    publishing;
    publicationCompletion;
    fullSyncTask;
    fullSyncScopeKey = '';
    fullSyncForcesPublication = false;
    officialRecovery;
    mcpDiscovery;
    marketplacePreview;
    snapshotReservations = new WeakMap();
    miniAppPublication;
    lastCachedRestoreScopeKey = '';
    cachedRestore;
    desiredScopeKey = '';
    pendingMiniAppScopeRetirement;
    reservations = {
        skillNames: [],
        mcpServerNames: [],
        toolNames: [],
    };
    revision = 0;
    snapshotPreparationRevision = 0;
    officialStateRevision = 0;
    localStateRevision = 0;
    disposed = false;
    disposalController = new AbortController();
    snapshot = EMPTY_PLUGIN_SNAPSHOT;
    desiredSnapshot = this.snapshot;
    mcpRuntime;
    capabilityGenerations;
    metrics;
    connectorRuntime;
    packageStorage;
    localDirectoryWatcher;
    constructor(options) {
        this.options = options;
        this.builder = new PluginSnapshotBuilder(options.mcpNames);
        this.metrics = new PluginSystemMetrics(options.metrics);
        this.packageStorage = new PluginPackageStorage({
            dataDir: options.dataDir,
            officialCacheRoot: options.officialCacheRoot,
            repository: options.repository,
            metrics: this.metrics,
        });
        this.marketplacePreview = new PluginMarketplacePreview({
            cache: new MarketplacePreviewCache(),
            initialize: () => this.initialization.promise,
            assertUsable: () => this.assertUsable(),
            readScope: () => this.readScope(),
            desiredScopeKey: () => this.desiredScopeKey,
            activateScopeBoundary: (scope) => this.activateScopeBoundary(scope),
            scheduleCachedRestore: () => this.scheduleCachedRestore(true),
            currentSnapshot: () => this.currentSnapshot,
            desiredSnapshot: () => this.desiredSnapshot,
            readSnapshotBuildInputs: (scope, desiredSnapshot) => this.readSnapshotBuildInputs(scope, false, {}, desiredSnapshot),
            builder: this.builder,
            isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
            recordBuildContext: (snapshot, context) => this.miniAppPublication.recordBuildContext(snapshot, context),
        });
        this.miniAppPublication = new PluginMiniAppPublicationController({
            host: this,
            packageStorage: this.packageStorage,
            builder: this.builder,
            isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
            recordReservations: (snapshot, reservations) => this.snapshotReservations.set(snapshot, reservations),
            initializeStarted: () => this.initializeStarted,
            isDisposed: () => this.disposed,
            getDesiredSnapshot: () => this.desiredSnapshot,
            setDesiredSnapshot: (snapshot) => {
                this.desiredSnapshot = snapshot;
            },
            preparePublication: (snapshot, publicationOptions) => this.preparePublication(snapshot, publicationOptions),
            queuePublication: (publication) => this.queuePublication(publication),
            readAvailableSnapshot: () => this.marketplacePreview.read({ reuseCached: true }),
            readOfficialInstallations: () => this.listOfficialPluginInstallations(),
            readSnapshotBuildInputs: () => this.readSnapshotBuildInputs(this.readScope(), false, {}),
            recordLocalMutation: () => {
                this.localStateRevision += 1;
                this.marketplacePreview.invalidate();
            },
        });
        const onLocalDirectoryChange = () => this.publishExternalLocalPluginChanges();
        this.localDirectoryWatcher = options.localDirectoryWatcherFactory
            ? options.localDirectoryWatcherFactory(onLocalDirectoryChange)
            : new LocalPluginDirectoryWatcher(path.join(options.dataDir, 'plugins'), onLocalDirectoryChange);
        this.mcpRuntime = options.mcpRuntime ?? new PluginMcpRuntime();
        this.capabilityGenerations = new PluginCapabilityGenerationRegistry(this.snapshot.revision, this.mcpRuntime);
        this.connectorRuntime = options.connectorRuntime ?? EMPTY_CONNECTOR_RUNTIME;
        this.officialRecovery = new OfficialPluginRecovery({
            delaysMs: options.officialRecoveryDelaysMs,
            isCurrentScope: (requested) => !this.disposed && requested === this.desiredScopeKey,
            synchronize: async (requested) => {
                if (requested !== this.desiredScopeKey)
                    return;
                await this.synchronizeOfficialState(true, 'recovery');
            },
        });
        this.mcpDiscovery = new PluginMcpDiscoveryScheduler({
            delaysMs: options.mcpDiscoveryDelaysMs,
            drainTimeoutMs: options.mcpDiscoveryDrainTimeoutMs,
            prepare: (snapshot) => this.preparePublication(snapshot, {}, 'discover'),
            isCurrent: (expectedRevision, requestedScopeKey) => !this.disposed &&
                requestedScopeKey === this.desiredScopeKey &&
                expectedRevision === this.snapshot.revision,
            queue: (publication) => this.queuePublication(publication),
        });
    }
    get currentSnapshot() {
        return this.snapshot;
    }
    attachPublicationPort(port) {
        if (this.publicationPort)
            throw new PluginSystemError('ALREADY_ATTACHED', 'publication port is already attached');
        this.publicationPort = port;
    }
    initialize() {
        if (this.initializeStarted)
            return this.initialization.promise;
        this.initializeStarted = true;
        this.initializationTask = this.initializeOnce();
        return this.initialization.promise;
    }
    async waitUntilReady(_options) {
        await this.initialization.promise;
        this.assertUsable();
        this.captureOfficialScope();
        await Promise.all([
            waitForScopedOperation(this.cachedRestore, this.desiredScopeKey, this.options.cacheRestoreAdmissionTimeoutMs),
            this.localDirectoryWatcher.whenIdle(),
        ]);
        this.assertUsable();
    }
    async prepareMiniAppTurn(input) {
        this.assertUsable();
        return prepareMiniAppTurn(this.miniAppPublication, input, () => ({
            snapshot: this.snapshot,
            inventory: this.mcpRuntime.exportInventory?.(),
        }));
    }
    async prepareTurnCapabilities(signal) {
        this.assertUsable();
        return preparePluginSystemTurnCapabilities(this.connectorRuntime, signal);
    }
    captureTurnCapabilities(preparation) {
        return capturePluginSystemTurnCapabilities(this.snapshot.turnCapabilities, preparation);
    }
    retainTurnCapabilities(capabilities) {
        this.capabilityGenerations.retain(capabilities.revision);
    }
    releaseTurnCapabilities(capabilities) {
        this.capabilityGenerations.release(capabilities.revision);
    }
    onHostIdle() {
        this.attemptPublication();
    }
    authContextChanged() {
        if (this.disposed || !this.initializeStarted)
            return;
        this.captureOfficialScope();
    }
    markReservationsDirty() {
        this.marketplacePreview.invalidate();
        if (this.initializeStarted)
            this.scheduleCachedRebuild();
    }
    async refresh() {
        await this.initialization.promise;
        this.assertUsable();
        this.marketplacePreview.invalidate();
        const scope = this.readScope();
        if (scopeKey(scope) !== this.desiredScopeKey) {
            this.activateScopeBoundary(scope);
            this.scheduleCachedRestore(false);
        }
        const requestedScopeKey = scopeKey(this.readScope());
        this.officialRecovery.cancelDelay();
        try {
            await this.synchronizeOfficialState(true, 'manual');
        }
        catch (error) {
            this.officialRecovery.schedule(requestedScopeKey);
            throw error;
        }
    }
    async refreshLocalPluginsForMarketplace(options = {}) {
        const next = await this.marketplacePreview.read(options);
        if (!sameLocalPluginProjection(next, this.desiredSnapshot)) {
            this.scheduleCachedRebuild(true);
        }
        return next;
    }
    captureOfficialScope() {
        const scope = this.readScope();
        if (scopeKey(scope) !== this.desiredScopeKey) {
            this.activateScopeBoundary(scope);
            this.scheduleCachedRestore(true);
        }
        return scope ? { ...scope } : undefined;
    }
    async revokeOfficialSelection(pluginName, scope, reason) {
        this.assertUsable();
        assertOfficialMutationScope(scope, this.desiredScopeKey, this.readScope());
        await this.options.onOfficialPluginRevoked?.({ pluginName, scope, ...(reason ? { reason } : {}) });
    }
    requestOfficialRecovery(expectedScope) {
        if (this.disposed ||
            scopeKey(expectedScope) !== this.desiredScopeKey ||
            scopeKey(expectedScope) !== scopeKey(this.readScope())) {
            return;
        }
        this.officialRecovery.request(scopeKey(expectedScope));
    }
    async applyOfficialMutation(mutation, expectedScope) {
        await this.initialization.promise;
        this.assertUsable();
        if (!this.options.officialReconciler?.reconcileMutation) {
            throw new PluginSystemError('AUTH_REQUIRED', 'official Plugin mutation requires identity');
        }
        assertOfficialMutationScope(expectedScope, this.desiredScopeKey, this.readScope());
        await this.runExclusive(async () => {
            const isCurrentScope = () => scopeKey(expectedScope) === this.desiredScopeKey &&
                scopeKey(expectedScope) === scopeKey(this.readScope());
            assertOfficialMutationScope(expectedScope, this.desiredScopeKey, this.readScope());
            const completion = deferred();
            const prepared = await prepareOfficialMutation({
                reconciler: this.options.officialReconciler,
                scope: expectedScope,
                mutation,
                shouldCommit: isCurrentScope,
                signal: this.disposalController.signal,
            });
            try {
                assertOfficialMutationScope(expectedScope, this.desiredScopeKey, this.readScope());
                const next = await this.buildSnapshot(expectedScope, true, {
                    ...(prepared ? { officialState: prepared.state } : {}),
                });
                assertOfficialMutationScope(expectedScope, this.desiredScopeKey, this.readScope());
                await revokeOfficialPluginSelection(this.options.onOfficialPluginRevoked, mutation, expectedScope);
                assertOfficialMutationScope(expectedScope, this.desiredScopeKey, this.readScope());
                await this.miniAppPublication.prepareSnapshotPublication(next, officialPublicationOptions(prepared, completion, () => new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed')));
                this.officialStateRevision += 1;
                this.marketplacePreview.invalidate();
                if (!mutation.installExists || !mutation.enabled) {
                    this.options.onPluginDeactivated?.(mutation.pluginName);
                }
            }
            catch (error) {
                await prepared?.abort();
                throw error;
            }
        });
    }
    async listOfficialPluginInstallations() {
        await this.initialization.promise;
        const scope = this.captureOfficialScope();
        if (!scope)
            return [];
        try {
            return this.options.repository.loadOfficialState(scope)?.installations ?? [];
        }
        catch {
            return [];
        }
    }
    async listOfficialPluginStates() {
        return this.packageStorage.readInstalledOfficialPluginStates(await this.listOfficialPluginInstallations());
    }
    materializeOfficialArchive(input) {
        this.assertUsable();
        return materializeOfficialPluginArchive({
            ...input,
            cacheRoot: this.options.officialCacheRoot,
        });
    }
    async setLocalPluginEnabled(pluginName, enabled) {
        await this.initialization.promise;
        this.assertUsable();
        return this.runExclusive(async () => {
            const inputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
            const discovered = this.marketplacePreview.buildFromInputs(inputs);
            const target = findLocalPlugin(discovered, pluginName);
            if (!target) {
                throw new PluginSystemError('PLUGIN_NOT_FOUND', 'local Plugin is not installed');
            }
            const priorEnabled = this.options.repository.isLocalPluginEnabled(target.rootPath);
            const completion = deferred();
            const next = this.miniAppPublication.buildPublicationSnapshot(inputs, {
                localEnabledOverrides: new Map([[target.rootPath, enabled]]),
            });
            await this.miniAppPublication.prepareSnapshotPublication(next, {
                completion,
                commit: async () => this.options.repository.setLocalPluginEnabled(target.rootPath, enabled),
                rollback: async () => this.options.repository.setLocalPluginEnabled(target.rootPath, priorEnabled),
            });
            this.localStateRevision += 1;
            if (!enabled)
                this.options.onPluginDeactivated?.(target.name);
            this.marketplacePreview.invalidate();
            return { installExists: true, enabled };
        });
    }
    async uninstallLocalPlugin(pluginName) {
        await this.initialization.promise;
        this.assertUsable();
        return this.runExclusive(async () => {
            const inputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
            const discovered = this.marketplacePreview.buildFromInputs(inputs);
            const target = findLocalPlugin(discovered, pluginName);
            if (!target)
                return { installExists: false, enabled: false };
            const rootPath = target.rootPath;
            const priorEnabled = this.options.repository.isLocalPluginEnabled(rootPath);
            const completion = deferred();
            const next = this.miniAppPublication.buildPublicationSnapshot(inputs, {
                excludedLocalRoots: new Set([rootPath]),
            });
            let staged;
            await this.miniAppPublication.prepareSnapshotPublication(next, {
                completion,
                commit: async () => {
                    staged = await this.packageStorage.stageAcceptedLocalRoot(rootPath);
                    this.options.repository.setLocalPluginEnabled(rootPath, true);
                },
                rollback: async () => {
                    try {
                        this.options.repository.setLocalPluginEnabled(rootPath, priorEnabled);
                    }
                    finally {
                        await staged?.restore();
                    }
                },
                finalize: async () => staged?.discard(),
            });
            this.localStateRevision += 1;
            this.options.onPluginDeactivated?.(target.name);
            this.marketplacePreview.invalidate();
            return { installExists: false, enabled: false };
        });
    }
    async importGithubPlugin(source) {
        await this.initialization.promise;
        this.assertUsable();
        if (!this.options.githubImporter) {
            throw new PluginSystemError('PLUGIN_IMPORT_UNAVAILABLE', 'GitHub Plugin import is unavailable');
        }
        const prepared = await this.options.githubImporter.prepare(source);
        try {
            if (!prepared.canImport) {
                throw new PluginSystemError('PLUGIN_NO_SUPPORTED_CAPABILITY', 'Plugin contains no valid Skill, MCP, or Hook capability');
            }
            return await this.runExclusive(async () => {
                const officialInstallations = await this.listOfficialPluginInstallations();
                const currentInputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
                const current = this.marketplacePreview.buildFromInputs(currentInputs);
                const key = normalizedPluginName(prepared.plugin.name);
                assertPluginNameAvailable(prepared.plugin.name, officialInstallations, current);
                const accepted = await this.packageStorage.acceptImportedLocalRoot(prepared.stagingRoot, prepared.plugin.name);
                try {
                    const nextInputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
                    const imported = nextInputs.localPackages.find((item) => normalizedPluginName(item.plugin.name) === key)?.plugin;
                    if (!imported) {
                        throw new PluginSystemError('PLUGIN_IMPORT_INVALID', 'Imported Plugin was not readable');
                    }
                    const completion = deferred();
                    const next = this.miniAppPublication.buildPublicationSnapshot(nextInputs, {});
                    await this.miniAppPublication.prepareSnapshotPublication(next, {
                        completion,
                        commit: async () => this.options.repository.setLocalPluginEnabled(accepted.rootPath, true),
                        rollback: accepted.restore,
                    });
                    this.localStateRevision += 1;
                    this.marketplacePreview.invalidate();
                    return imported;
                }
                catch (error) {
                    await ignoreFailure(accepted.restore());
                    throw error;
                }
            });
        }
        finally {
            await prepared.discard();
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.miniAppPublication.cancelPendingStarts();
        for (const plugin of this.snapshot.enabledPlugins)
            this.options.onPluginDeactivated?.(plugin.name);
        this.localDirectoryWatcher.close();
        this.disposalController.abort();
        this.snapshotPreparationRevision += 1;
        const error = new PluginSystemError('DISPOSED', 'PluginSystem is disposed');
        this.pendingPublication?.completion?.reject(error);
        if (this.pendingPublication)
            this.metrics.publication(this.pendingPublication, 'superseded');
        await ignoreFailure(this.pendingPublication?.cancel?.());
        this.pendingPublication = undefined;
        await ignoreFailure(this.publishing);
        await ignoreFailure(this.publicationCompletion);
        await ignoreFailure(this.initializationTask);
        await this.operationTail;
        await this.localDirectoryWatcher.whenIdle();
        await ignoreFailure(this.fullSyncTask);
        await this.officialRecovery.dispose();
        await this.mcpDiscovery.dispose();
        await this.capabilityGenerations.dispose();
        await this.miniAppPublication.close();
    }
    async initializeOnce() {
        try {
            assertPluginSystemPublicationAttached(Boolean(this.publicationPort));
            this.desiredScopeKey = scopeKey(this.readScope());
            await this.localDirectoryWatcher.start();
            this.scheduleCachedRestore(true);
            this.initialization.resolve();
        }
        catch (error) {
            this.initialization.reject(error);
        }
    }
    async rebuildForCurrentScope(pruneMissingLocalPlugins = false, scope = this.readScope(), buildOptions = {}, publicationOptions = {}) {
        const next = await this.buildSnapshot(scope, pruneMissingLocalPlugins, buildOptions);
        if (scopeKey(scope) !== this.desiredScopeKey)
            return false;
        await this.miniAppPublication.prepareSnapshotPublication(next, publicationOptions);
        return true;
    }
    async preparePublication(next, options, inventoryMode = 'cached-only', currentSnapshot = this.snapshot) {
        const intendedScopeKey = this.desiredScopeKey;
        const preparationRevision = this.options.mcpRuntimeFactory
            ? ++this.snapshotPreparationRevision
            : this.snapshotPreparationRevision;
        const prepared = await preparePluginPublication({
            snapshot: this.miniAppPublication.projectOrdinaryPublication(next),
            currentSnapshot,
            publicationScopeKey: intendedScopeKey,
            options,
            ...(this.miniAppPublication.participant
                ? { participant: this.miniAppPublication.participant }
                : {}),
            ...(this.options.mcpRuntimeFactory ? { factory: this.options.mcpRuntimeFactory } : {}),
            currentRuntime: this.mcpRuntime,
            inventoryMode,
            signal: this.disposalController.signal,
            buildSnapshot: (inputs, buildOptions) => this.miniAppPublication.buildPublicationSnapshot(inputs, buildOptions),
            isDisposed: () => this.disposed,
            isSuperseded: () => preparationRevision !== this.snapshotPreparationRevision,
        });
        this.miniAppPublication.materializeBuildContext(prepared.snapshot);
        const reservations = this.snapshotReservations.get(prepared.snapshot) ?? this.snapshotReservations.get(next);
        if (reservations)
            this.snapshotReservations.set(prepared.snapshot, reservations);
        return prepared.publication;
    }
    scheduleCachedRestore(startFullSync = false) {
        const scope = this.readScope();
        const cachedRestore = this.restoreCachedScope(scope);
        const requestedScopeKey = scopeKey(scope);
        this.cachedRestore = { scopeKey: requestedScopeKey, operation: cachedRestore };
        settleInBackground(cachedRestore);
        if (startFullSync && scope && this.options.officialReconciler) {
            settleInBackground((async () => {
                await cachedRestore;
                if (requestedScopeKey === this.desiredScopeKey) {
                    await ignoreFailure(this.synchronizeOfficialState());
                }
            })());
        }
    }
    scheduleCachedRebuild(pruneMissingLocalPlugins = false) {
        settleInBackground(this.rebuildCachedScope(this.readScope(), pruneMissingLocalPlugins));
    }
    async publishExternalLocalPluginChanges() {
        if (this.disposed || !this.initializeStarted)
            return;
        this.marketplacePreview.invalidate();
        const scope = this.readScope();
        try {
            await this.runExclusive(async () => {
                if (this.disposed || scopeKey(scope) !== this.desiredScopeKey)
                    return;
                const next = await this.buildSnapshot(scope, true);
                if (this.disposed ||
                    scopeKey(scope) !== this.desiredScopeKey ||
                    sameLocalPluginProjection(next, this.desiredSnapshot)) {
                    return;
                }
                this.localStateRevision += 1;
                const completion = deferred();
                const removedHookPlugins = removedPluginHookNames(this.snapshot, next);
                await this.miniAppPublication.prepareSnapshotPublication(next, { completion });
                for (const pluginName of removedHookPlugins) {
                    this.options.onPluginDeactivated?.(pluginName);
                }
            });
        }
        catch {
            this.marketplacePreview.invalidate();
        }
    }
    synchronizeOfficialState(forcePublication = false, trigger = forcePublication ? 'manual' : 'startup') {
        const scope = this.readScope();
        const requestedScopeKey = scopeKey(scope);
        if (this.fullSyncTask) {
            if (trigger !== 'recovery' &&
                this.fullSyncScopeKey === requestedScopeKey &&
                (!forcePublication || this.fullSyncForcesPublication)) {
                return this.fullSyncTask;
            }
            return this.retryFullSyncAfter(this.fullSyncTask, forcePublication, trigger);
        }
        const operation = this.performOfficialSynchronization(scope, requestedScopeKey, forcePublication, trigger);
        const completion = this.completeFullSync(operation);
        this.fullSyncScopeKey = requestedScopeKey;
        this.fullSyncForcesPublication = forcePublication;
        this.fullSyncTask = completion;
        return completion;
    }
    async restoreCachedScope(scope) {
        const startedAt = Date.now();
        let status = 'success';
        try {
            await this.runExclusive(async () => {
                if (scopeKey(scope) !== this.desiredScopeKey)
                    return;
                const completion = deferred();
                const queued = await this.rebuildForCurrentScope(true, scope, {}, { completion });
                if (!queued)
                    return;
                if (scopeKey(scope) === this.desiredScopeKey) {
                    this.lastCachedRestoreScopeKey = scopeKey(scope);
                }
            });
        }
        catch {
            status = 'error';
        }
        finally {
            this.metrics.operation('cache_restore', status, startedAt);
        }
    }
    async rebuildCachedScope(scope, pruneMissingLocalPlugins) {
        try {
            await this.runExclusive(async () => {
                if (scopeKey(scope) !== this.desiredScopeKey)
                    return;
                await this.rebuildForCurrentScope(pruneMissingLocalPlugins, scope);
            });
        }
        catch {
            this.marketplacePreview.invalidate();
        }
    }
    async retryFullSyncAfter(current, forcePublication, trigger) {
        await ignoreFailure(current);
        await this.synchronizeOfficialState(forcePublication, trigger);
    }
    async completeFullSync(operation) {
        try {
            await operation;
        }
        finally {
            this.fullSyncTask = undefined;
            this.fullSyncScopeKey = '';
            this.fullSyncForcesPublication = false;
        }
    }
    async performOfficialSynchronization(scope, requestedScopeKey, forcePublication, trigger) {
        while (!this.disposed && requestedScopeKey === this.desiredScopeKey) {
            const outcome = await this.performOfficialSynchronizationAttempt(scope, requestedScopeKey, forcePublication, trigger);
            if (outcome === 'complete')
                return;
        }
    }
    async performOfficialSynchronizationAttempt(scope, requestedScopeKey, forcePublication, trigger) {
        const expectedOfficialRevision = this.officialStateRevision;
        const expectedLocalRevision = this.localStateRevision;
        const isCurrentScope = () => requestedScopeKey === this.desiredScopeKey &&
            requestedScopeKey === scopeKey(this.readScope());
        const prepared = await prepareOfficialFullState({
            reconciler: this.options.officialReconciler,
            scope,
            isCurrentScope,
            signal: this.disposalController.signal,
            trigger,
            record: (status, startedAt) => this.metrics.officialSync(trigger, status, startedAt),
            scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
        });
        const decision = await decidePreparedOfficialSync({
            unavailable: this.disposed || requestedScopeKey !== this.desiredScopeKey,
            forcePublication,
            revisionChanged: expectedOfficialRevision !== this.officialStateRevision,
            cachedRestoreCurrent: this.lastCachedRestoreScopeKey === requestedScopeKey,
            prepared,
        });
        if (decision !== 'proceed') {
            if (decision === 'complete' && prepared?.incomplete) {
                handleIncompleteOfficialSync({
                    trigger,
                    failedPackageCount: prepared.failedPackageCount,
                    scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
                });
            }
            return decision;
        }
        const publication = await this.prepareOfficialPublication(scope, prepared);
        if (!publication)
            return 'retry';
        const queued = await this.enqueuePreparedOfficialPublication({
            requestedScopeKey,
            expectedOfficialRevision,
            expectedLocalRevision,
            next: publication.next,
            publication: publication.pending,
        });
        if (!queued) {
            await ignoreFailure(publication.pending.cancel?.());
            return 'retry';
        }
        const outcome = await waitForOfficialPublication({
            completion: publication.completion.promise,
            requestedScopeKey,
            currentScopeKey: () => this.desiredScopeKey,
        });
        if (outcome !== 'complete')
            return outcome;
        this.marketplacePreview.invalidate();
        if (prepared?.incomplete) {
            handleIncompleteOfficialSync({
                trigger,
                failedPackageCount: prepared.failedPackageCount,
                scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
            });
            return 'complete';
        }
        this.officialRecovery.succeeded(requestedScopeKey);
        return 'complete';
    }
    async prepareOfficialPublication(scope, prepared) {
        let next;
        try {
            next = await this.buildSnapshot(scope, true, prepared ? { officialState: prepared.state } : {});
        }
        catch (error) {
            await prepared?.abort();
            throw error;
        }
        const completion = deferred();
        try {
            const pending = await this.preparePublication(next, officialPublicationOptions(prepared, completion, () => new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed')));
            return { next, pending, completion };
        }
        catch (error) {
            if (isPublicationSuperseded(error) && !this.disposed)
                return undefined;
            throw error;
        }
    }
    enqueuePreparedOfficialPublication(input) {
        return this.runExclusive(async () => {
            if (this.disposed ||
                input.requestedScopeKey !== this.desiredScopeKey ||
                input.expectedOfficialRevision !== this.officialStateRevision ||
                input.expectedLocalRevision !== this.localStateRevision) {
                return false;
            }
            this.desiredSnapshot = input.next;
            this.queuePublication(input.publication);
            return true;
        });
    }
    activateScopeBoundary(scope) {
        this.miniAppPublication.cancelPendingStarts();
        if (this.snapshot.officialPackages.some(({ plugin }) => plugin?.miniapp)) {
            this.pendingMiniAppScopeRetirement ??= this.snapshot;
        }
        this.officialRecovery.scopeChanged();
        this.mcpDiscovery.scopeChanged();
        this.desiredScopeKey = scopeKey(scope);
        this.lastCachedRestoreScopeKey = '';
        this.snapshotPreparationRevision += 1;
        this.marketplacePreview.invalidate();
        const pending = this.pendingPublication;
        if (pending) {
            pending.completion?.reject(new PluginSystemError('SCOPE_CHANGED', 'Plugin publication identity changed'));
            this.metrics.publication(pending, 'superseded');
            settleInBackground(ignoreFailure(pending.cancel?.()));
            this.pendingPublication = undefined;
        }
        this.revision += 1;
        const customOnly = buildCustomOnlySnapshot({
            builder: this.builder,
            revision: `plugin-snapshot-${this.revision}`,
            source: this.snapshot,
            isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
            reservations: this.reservations,
        });
        this.miniAppPublication.recordBuildContext(customOnly.snapshot, {
            input: customOnly.inputs,
            options: {},
        });
        const next = this.miniAppPublication.projectAcceptedSnapshot(customOnly.snapshot, this.snapshot);
        const inventory = localSnapshotInventory(next, this.mcpRuntime.exportInventory?.());
        const nextRuntime = this.options.mcpRuntimeFactory?.() ?? new PluginMcpRuntime();
        if (inventory)
            nextRuntime.importInventory?.(inventory);
        this.mcpRuntime = nextRuntime;
        this.snapshot = next;
        if (!this.disposed)
            this.options.onCapabilitiesChanged?.(this.snapshot.turnCapabilities);
        this.desiredSnapshot = next;
        this.capabilityGenerations.replace(next.revision, nextRuntime);
        this.metrics.snapshot(next);
    }
    async buildSnapshot(scope, pruneMissingLocalPlugins = true, options = {}) {
        const input = await this.readSnapshotBuildInputs(scope, pruneMissingLocalPlugins, options);
        return this.miniAppPublication.buildPublicationSnapshot(input, options);
    }
    async readSnapshotBuildInputs(scope, pruneMissingLocalPlugins, options, desiredSnapshot = this.desiredSnapshot) {
        return readPluginSnapshotInputs({
            packageStorage: this.packageStorage,
            repository: this.options.repository,
            listReservations: this.options.listReservations,
            desiredSnapshot,
            scope,
            pruneMissingLocalPlugins,
            buildOptions: options,
        });
    }
    queuePublication(publication) {
        if (this.disposed) {
            publication.completion?.reject(new PluginSystemError('DISPOSED', 'PluginSystem is disposed'));
            settleInBackground(ignoreFailure(publication.cancel?.()));
            return;
        }
        this.pendingPublication?.completion?.reject(new PluginSystemError('PUBLICATION_SUPERSEDED', 'Plugin publication was superseded'));
        if (this.pendingPublication)
            this.metrics.publication(this.pendingPublication, 'superseded');
        settleInBackground(ignoreFailure(this.pendingPublication?.cancel?.()));
        this.pendingPublication = publication;
        this.metrics.publicationQueued(publication);
        this.miniAppPublication.bindRestartCancellation(publication, () => {
            if (this.pendingPublication === publication)
                this.pendingPublication = undefined;
        });
        this.attemptPublication();
    }
    attemptPublication() {
        if (this.disposed || this.publishing || !this.pendingPublication || !this.publicationPort)
            return;
        const pending = this.pendingPublication;
        const started = this.publicationPort.tryPublish(() => this.publishPending(pending));
        if (!started)
            return;
        this.publishing = started;
        this.publicationCompletion = completePluginPublication(started, pending, () => {
            if (this.publishing === started)
                this.publishing = undefined;
            if (this.pendingPublication) {
                this.attemptPublication();
                if (!this.publishing)
                    setImmediate(() => this.attemptPublication());
            }
        });
    }
    async publishPending(pending) {
        if (this.pendingPublication === pending)
            this.pendingPublication = undefined;
        let prepared;
        let adoptedPreparedRuntime = false;
        try {
            prepared = await pending.prepare();
            assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
            if (prepared.preparedRuntime) {
                await this.publishPreparedRuntime(pending, prepared, prepared.preparedRuntime);
                adoptedPreparedRuntime = true;
            }
            else {
                await this.publishWithCurrentRuntime(pending, prepared);
            }
            this.metrics.publication(pending, 'success');
            if (pending.mcpDiscovery) {
                this.mcpDiscovery.published(pending.mcpDiscovery, this.snapshot, this.desiredScopeKey);
            }
        }
        catch (error) {
            if (prepared?.preparedRuntime && !adoptedPreparedRuntime) {
                await ignoreFailure(prepared.preparedRuntime.close());
            }
            if (prepared)
                await ignoreFailure(rollbackPreparedPluginPublication(prepared));
            const recovered = await recoverDestructivePluginPublication({
                pending,
                currentSnapshot: this.snapshot,
                currentRuntime: this.mcpRuntime,
                factory: this.options.mcpRuntimeFactory,
                adoptPrepared: (recovery) => this.publishPreparedRuntime({
                    scopeKey: this.desiredScopeKey,
                    prepare: async () => recovery,
                }, recovery, recovery.preparedRuntime),
                adoptOwnerFailure: (snapshot) => {
                    const adopted = this.adoptPublishedSnapshot(snapshot, this.snapshot);
                    this.snapshot = adopted;
                    if (!this.disposed)
                        this.options.onCapabilitiesChanged?.(this.snapshot.turnCapabilities);
                    this.desiredSnapshot = adopted;
                    this.capabilityGenerations.replaceRevision(adopted.revision);
                    settleInBackground(this.capabilityGenerations.adoptManagedServers(adopted.mcpServers));
                },
            });
            if (!recovered && !prepared?.preparedRuntime) {
                await ignoreFailure(this.mcpRuntime.reconcile(this.snapshot.mcpServers));
            }
            this.metrics.publication(pending, 'error');
            throwRecoveredDestructivePublicationFailure(error, recovered);
            throw this.miniAppPublication.normalizePreparationError(error, prepared);
        }
    }
    async publishPreparedRuntime(pending, prepared, preparedRuntime) {
        this.miniAppPublication.materializeBuildContext(prepared.snapshot, prepared.snapshotSource);
        await commitPreparedPluginPublication(prepared);
        assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
        this.mcpRuntime = preparedRuntime;
        const published = this.adoptPublishedSnapshot(prepared.snapshot);
        this.snapshot = published;
        if (!this.disposed)
            this.options.onCapabilitiesChanged?.(this.snapshot.turnCapabilities);
        this.desiredSnapshot = published;
        this.capabilityGenerations.replace(published.revision, preparedRuntime, preparedPluginPublicationFinalizer(prepared));
        await this.capabilityGenerations.adoptManagedServers(published.mcpServers);
        pending.completion?.resolve();
    }
    async publishWithCurrentRuntime(pending, prepared) {
        this.miniAppPublication.materializeBuildContext(prepared.snapshot, prepared.snapshotSource);
        if (this.capabilityGenerations.currentLeaseCount > 0) {
            throw new PluginSystemError('MCP_RUNTIME_FACTORY_MISSING', 'cannot publish a Plugin snapshot during execution without an MCP runtime factory');
        }
        const mcp = await this.mcpRuntime.reconcile(prepared.snapshot.mcpServers);
        assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
        await commitPreparedPluginPublication(prepared);
        assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
        const published = withPluginMcpRuntime(prepared.snapshot, mcp.runtimeTools, mcp.runtimeToolBindings ?? [], mcp.diagnostics);
        const reservations = this.snapshotReservations.get(prepared.snapshot);
        if (reservations)
            this.snapshotReservations.set(published, reservations);
        const adopted = this.adoptPublishedSnapshot(published, prepared.snapshot);
        this.snapshot = adopted;
        if (!this.disposed)
            this.options.onCapabilitiesChanged?.(this.snapshot.turnCapabilities);
        this.desiredSnapshot = adopted;
        this.capabilityGenerations.replaceRevision(adopted.revision);
        await this.capabilityGenerations.adoptManagedServers(adopted.mcpServers);
        pending.completion?.resolve();
        const finalize = preparedPluginPublicationFinalizer(prepared);
        if (finalize)
            settleInBackground(ignoreFailure(finalize()));
    }
    adoptPublishedSnapshot(snapshot, buildContextSource = snapshot) {
        const reservations = this.snapshotReservations.get(snapshot);
        if (reservations)
            this.reservations = reservations;
        this.revision += 1;
        const published = withPluginSnapshotRevision(snapshot, `plugin-snapshot-${this.revision}`);
        this.miniAppPublication.inheritBuildContext(buildContextSource, published);
        this.metrics.snapshot(published);
        return published;
    }
    readScope() {
        return resolvePluginRepositoryScope(this.options);
    }
    runExclusive(operation) {
        const result = runAfter(this.operationTail, async () => {
            this.captureOfficialScope();
            const previousScope = this.pendingMiniAppScopeRetirement;
            if (previousScope) {
                // Retire account-owned generations before the same cached package can be reused.
                // The synchronous scope boundary has already removed them from the visible snapshot.
                const completion = deferred();
                this.queuePublication(await this.preparePublication(this.snapshot, { completion }, 'cached-only', previousScope));
                await completion.promise;
                this.pendingMiniAppScopeRetirement = undefined;
            }
            return operation();
        });
        this.operationTail = ignoreFailure(result);
        return result;
    }
    assertUsable() {
        if (this.disposed)
            throw new PluginSystemError('DISPOSED', 'PluginSystem is disposed');
    }
}
//# sourceMappingURL=plugin-system.js.map