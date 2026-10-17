import { MiniAppError } from '../../../../miniapp/index.js';
import { normalizeMiniAppPreparationError, } from '../../../publication.js';
import { PluginSystemError } from '../../../errors.js';
import { deferred, ignoreFailure, runAllFinally } from '../../../plugin-system-helpers.js';
import { PluginNameReservation } from '../../import/plugin-name-reservation.js';
import { buildPluginSnapshotFromInputs } from '../snapshot-inputs.js';
import { activateAvailableMiniApp } from './activation.js';
import { listEnabledMiniAppDefinitions, listAcceptedMiniApps, miniAppCandidateFromPackage, sameMiniAppCandidate, } from './candidate.js';
import { attachSupervisedMiniAppPublication, isSupervisedBusyError, normalizeSupervisedPreparationError, SupervisedMiniAppPublicationParticipant, } from './publication.js';
import { projectColdMiniAppPublication } from './projection.js';
import { restartSupervisedMiniAppPublication } from './restart.js';
/** Owns the MiniApp-specific facade while PluginSystem retains the generic transaction. */
export class PluginMiniAppPublicationController {
    options;
    participantValue;
    buildContexts = new WeakMap();
    startups = new Map();
    constructor(options) {
        this.options = options;
        this.nameReservation = new PluginNameReservation({
            readOfficialInstallations: options.readOfficialInstallations,
            readLocalPackages: () => options.packageStorage.scanLocalPackages(),
            isLocalEnabled: options.isLocalEnabled,
        });
    }
    nameReservation;
    get participant() {
        return this.participantValue;
    }
    attach(input) {
        this.participantValue = attachSupervisedMiniAppPublication({
            current: this.participantValue,
            initializeStarted: this.options.initializeStarted(),
            supervisor: input.supervisor,
        });
    }
    async restart(input) {
        this.requireParticipant();
        throwIfAborted(input.signal);
        const cancelledStart = await this.cancelStartup(input.pluginId);
        if (cancelledStart &&
            !this.listAcceptedMiniApps().some(({ candidate }) => candidate.pluginId === input.pluginId)) {
            return this.ensureStarted(input);
        }
        const host = this.options.host;
        await restartSupervisedMiniAppPublication(input, {
            initialize: () => host.initialize(),
            assertUsable: () => host.assertUsable(),
            runExclusive: (operation) => host.runExclusive(operation),
            currentSnapshot: () => host.currentSnapshot,
            setDesiredSnapshot: this.options.setDesiredSnapshot,
            prepare: (snapshot, options) => this.prepareSnapshotPublication(snapshot, options),
        });
    }
    listAcceptedMiniApps() {
        return listAcceptedMiniApps(this.options.host.currentSnapshot);
    }
    isAcceptedMiniAppRunning(pluginId) {
        const accepted = this.listAcceptedMiniApps().find(({ candidate }) => candidate.pluginId === pluginId);
        return accepted
            ? (this.participantValue?.isAcceptedCandidateRunning(accepted.candidate) ?? false)
            : false;
    }
    isAcceptedMcpEndpointCurrent(pluginId, identity) {
        return this.participantValue?.isAcceptedMcpEndpointCurrent(pluginId, identity) ?? false;
    }
    materializeRuntimePackage(input) {
        return this.options.packageStorage.materializeMiniAppRuntimePackage(input);
    }
    async initializeWorkspace(input) {
        const host = this.options.host;
        await host.initialize();
        host.assertUsable();
        return host.runExclusive(async () => {
            throwIfAborted(input.signal);
            await this.nameReservation.assertAvailable(input.pluginId, {
                allowEnabledMiniAppUpdate: true,
            });
            throwIfAborted(input.signal);
            return this.options.packageStorage.initializeWorkspaceMiniApp(input);
        });
    }
    async publishWorkspace(input) {
        const host = this.options.host;
        await host.initialize();
        host.assertUsable();
        throwIfAborted(input.signal);
        await this.cancelStartup(input.pluginId);
        return host.runExclusive(async () => {
            throwIfAborted(input.signal);
            await this.nameReservation.assertAvailable(input.pluginId, {
                allowEnabledMiniAppUpdate: true,
            });
            throwIfAborted(input.signal);
            const transaction = await this.options.packageStorage.stageWorkspaceMiniAppCandidate(input);
            try {
                throwIfAborted(input.signal);
                await transaction.install();
                throwIfAborted(input.signal);
                const inputs = await this.options.readSnapshotBuildInputs();
                const installed = inputs.localPackages.find(({ plugin }) => plugin.name === input.pluginId);
                if (!installed?.plugin.miniapp || installed.contentDigest !== transaction.contentDigest) {
                    throw new PluginSystemError('MINIAPP_PREPARATION_FAILED', 'installed MiniApp candidate identity changed', { reasonCode: 'CANDIDATE_CHANGED' });
                }
                const next = this.buildPublicationSnapshot(inputs, {});
                const projection = next.localPlugins.find(({ name }) => name === input.pluginId);
                if (!projection?.enabled) {
                    throw new PluginSystemError('PLUGIN_NOT_ENABLED', 'Mini App Plugin is disabled');
                }
                const completion = deferred();
                await this.prepareSnapshotPublication(next, {
                    completion,
                    requiredMiniAppPluginId: input.pluginId,
                    forceRuntimePublicationPluginId: input.pluginId,
                    ...(input.signal ? { signal: input.signal } : {}),
                    commit: async () => throwIfAborted(input.signal),
                    rollback: transaction.rollback,
                    finalize: transaction.finalize,
                    cancel: transaction.rollback,
                });
                this.options.recordLocalMutation();
                const accepted = this.listAcceptedMiniApps().find(({ candidate }) => candidate.pluginId === input.pluginId);
                if (accepted)
                    return accepted;
                throw new PluginSystemError('MINIAPP_PREPARATION_FAILED', 'Mini App publication was not accepted', { reasonCode: 'PUBLICATION_NOT_ACCEPTED' });
            }
            catch (error) {
                await ignoreFailure(transaction.rollback());
                throw error;
            }
        });
    }
    async stop(input) {
        const participant = this.requireParticipant();
        const host = this.options.host;
        await host.initialize();
        host.assertUsable();
        throwIfAborted(input.signal);
        const cancelledStart = await this.cancelStartup(input.pluginId);
        await host.runExclusive(async () => {
            throwIfAborted(input.signal);
            const current = host.currentSnapshot;
            if (!this.listAcceptedMiniApps().some(({ candidate }) => candidate.pluginId === input.pluginId)) {
                if (cancelledStart)
                    return;
                throw new PluginSystemError('MINIAPP_NOT_ACCEPTED', 'Mini App definition is not accepted');
            }
            const completion = deferred();
            await participant.withStopRequest(input, () => this.prepareSnapshotPublication(current, {
                completion,
                requiredMiniAppPluginId: input.pluginId,
                ...(input.signal ? { signal: input.signal } : {}),
            }));
        });
    }
    async listAvailableMiniApps() {
        return (await this.listAvailableDefinitions()).map(({ candidate, ...metadata }) => ({
            pluginId: candidate.pluginId,
            ...metadata,
        }));
    }
    async listAvailableDefinitions() {
        await this.options.host.initialize();
        this.options.host.assertUsable();
        return listEnabledMiniAppDefinitions(await this.options.readAvailableSnapshot());
    }
    async ensureStarted(input) {
        throwIfAborted(input.signal);
        let startup = this.startups.get(input.pluginId);
        if (!startup) {
            const controller = new AbortController();
            startup = {
                controller,
                promise: this.ensureAcceptedRuntime(input.pluginId, controller.signal),
            };
            this.startups.set(input.pluginId, startup);
        }
        await waitForStartup(startup.promise, input.signal);
    }
    async ensureAcceptedRuntime(pluginId, signal) {
        try {
            await this.options.host.initialize();
            this.options.host.assertUsable();
            throwIfAborted(signal);
            if (!this.isAcceptedMiniAppRunning(pluginId)) {
                await this.activate({ pluginId, startOnly: true, signal });
            }
        }
        finally {
            if (this.startups.get(pluginId)?.controller.signal === signal)
                this.startups.delete(pluginId);
        }
    }
    cancelPendingStarts() {
        for (const startup of this.startups.values())
            cancelStartupOwner(startup);
    }
    async cancelStartup(pluginId) {
        const startup = this.startups.get(pluginId);
        if (!startup)
            return false;
        cancelStartupOwner(startup);
        try {
            await startup.promise;
        }
        catch (error) {
            if (!isCancelledStartup(error, startup.controller.signal.reason))
                throw error;
        }
        return true;
    }
    invalidateChangedStartups(snapshot, options) {
        if (options.requiredMiniAppPluginId || options.mcpDiscovery)
            return;
        const definitions = listEnabledMiniAppDefinitions(snapshot);
        for (const [pluginId, startup] of this.startups) {
            const current = definitions.find(({ candidate }) => candidate.pluginId === pluginId)?.candidate;
            if (!current || (startup.candidate && !sameMiniAppCandidate(current, startup.candidate))) {
                cancelStartupOwner(startup);
            }
        }
    }
    async activate(input) {
        const participant = this.requireParticipant();
        const host = this.options.host;
        await activateAvailableMiniApp(input, {
            initialize: () => host.initialize(),
            assertUsable: () => host.assertUsable(),
            runExclusive: (operation) => host.runExclusive(operation),
            readAvailableSnapshot: this.options.readAvailableSnapshot,
            isAcceptedCandidateRunning: (candidate) => participant.isAcceptedCandidateRunning(candidate),
            buildContext: (snapshot) => this.buildContext(snapshot),
            currentSnapshot: () => host.currentSnapshot,
            setDesiredSnapshot: this.options.setDesiredSnapshot,
            buildSnapshot: (snapshotInput, buildOptions) => this.buildPublicationSnapshot(snapshotInput, buildOptions),
            prepareStart: (candidate, signal) => {
                const startup = this.startups.get(candidate.pluginId);
                if (startup)
                    startup.candidate = candidate;
                return participant.prepareStart(candidate, signal);
            },
            prepare: (snapshot, publicationOptions) => this.prepareSnapshotPublication(snapshot, publicationOptions),
        });
    }
    async prepareSnapshotPublication(candidate, options = {}) {
        this.invalidateChangedStartups(candidate, options);
        const previous = this.options.getDesiredSnapshot();
        this.options.setDesiredSnapshot(candidate);
        try {
            this.options.queuePublication(await this.options.preparePublication(candidate, options));
            await options.completion?.promise;
        }
        catch (error) {
            this.options.setDesiredSnapshot(this.recover(error, previous, candidate, this.options.getDesiredSnapshot()));
            throw error;
        }
    }
    async verifyCandidate(candidate) {
        if (this.options.isDisposed())
            return false;
        try {
            const packageEntry = await this.options.packageStorage.readLocalMiniAppPackageRoot(candidate.packageRoot);
            return (packageEntry.plugin.rootPath === candidate.packageRoot &&
                packageEntry.plugin.name === candidate.pluginId &&
                sameMiniAppCandidate(miniAppCandidateFromPackage(packageEntry), candidate));
        }
        catch {
            return false;
        }
    }
    recover(error, previous, candidate, current) {
        return SupervisedMiniAppPublicationParticipant.recover(error, previous, candidate, current);
    }
    projectAcceptedSnapshot(snapshot, rosterSource) {
        return this.participantValue?.projectAcceptedSnapshot(snapshot, rosterSource) ?? snapshot;
    }
    /** Removes cold runtime contributions when this Host has no Supervisor participant. */
    projectOrdinaryPublication(snapshot) {
        if (this.participantValue || listEnabledMiniAppDefinitions(snapshot).length === 0) {
            return snapshot;
        }
        const buildContext = this.buildContext(snapshot);
        if (!buildContext) {
            throw new PluginSystemError('MINIAPP_CATALOG_STALE', 'Mini App definition catalog cannot be projected for publication');
        }
        return projectColdMiniAppPublication({
            snapshot,
            buildContext,
            buildSnapshot: (input, options) => this.buildPublicationSnapshot(input, options),
        });
    }
    buildPublicationSnapshot(input, options) {
        const snapshot = buildPluginSnapshotFromInputs({
            builder: this.options.builder,
            snapshotInputs: input,
            buildOptions: options,
            isLocalEnabled: this.options.isLocalEnabled,
        });
        this.recordBuildContext(snapshot, { input, options });
        this.options.recordReservations(snapshot, input.reservations);
        return snapshot;
    }
    recordBuildContext(snapshot, context) {
        this.buildContexts.set(snapshot, context);
        this.participantValue?.recordBuildContext(snapshot, context);
    }
    materializeBuildContext(snapshot, fallback) {
        const context = this.buildContext(snapshot) ?? (fallback ? this.buildContext(fallback) : undefined);
        if (context)
            this.recordBuildContext(snapshot, context);
    }
    inheritBuildContext(source, target) {
        const context = this.buildContext(source);
        if (context)
            this.recordBuildContext(target, context);
    }
    buildContext(snapshot) {
        return this.participantValue?.buildContext(snapshot) ?? this.buildContexts.get(snapshot);
    }
    requireParticipant() {
        if (this.participantValue)
            return this.participantValue;
        throw new PluginSystemError('MINIAPP_PUBLICATION_NOT_ATTACHED', 'Mini App publication participant is not attached');
    }
    bindRestartCancellation(publication, removePending) {
        publication.bindMiniAppRestartCancellation?.(removePending);
    }
    normalizePreparationError(error, prepared) {
        if (isSupervisedBusyError(error)) {
            return normalizeSupervisedPreparationError(error);
        }
        return normalizeMiniAppPreparationError(error, prepared?.participant);
    }
    async close() {
        this.cancelPendingStarts();
        await runAllFinally([
            ...[...this.startups.values()].map((startup) => async () => {
                try {
                    await startup.promise;
                }
                catch (error) {
                    if (!isCancelledStartup(error, startup.controller.signal.reason))
                        throw error;
                }
            }),
            () => this.participantValue?.close(),
        ]);
    }
}
function cancelStartupOwner(startup) {
    // A newer Supervisor preparation must be able to drain this cancelled owner.
    startup.controller.abort(new MiniAppError('SUPERSEDED', 'Mini App startup was superseded'));
}
function isCancelledStartup(error, reason) {
    return (error === reason ||
        (error instanceof PluginSystemError &&
            error.code === 'MINIAPP_PREPARATION_FAILED' &&
            error.cause === reason));
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    if (signal.reason instanceof Error)
        throw signal.reason;
    const error = new Error('Mini App action aborted');
    error.name = 'AbortError';
    throw error;
}
async function waitForStartup(startup, signal) {
    if (!signal)
        return startup;
    throwIfAborted(signal);
    let abort;
    const cancellation = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        await Promise.race([startup, cancellation]);
        throwIfAborted(signal);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
//# sourceMappingURL=controller.js.map