import { miniAppBusyReason, miniAppFailureReasonCode, } from '../../../../miniapp/index.js';
import { PluginSystemError } from '../../../errors.js';
import { runAllFinally } from '../../../plugin-system-helpers.js';
import { withPluginMcpRuntime, } from '../snapshot-builder.js';
import { listAcceptedMiniApps, listEnabledMiniAppDefinitions, miniAppCandidateFromPackage, sameMiniAppCandidate, sameRunningGeneration, } from './candidate.js';
import { buildSelectiveMiniAppInputs, miniAppManagedServerNames, ordinaryPackageContribution, retainRuntimeMiniAppContribution, withEnabledPluginRoster, } from './projection.js';
/** Adapts accepted MiniApp contributions to the ordinary Plugin publication transaction. */
export class SupervisedMiniAppPublicationParticipant {
    options;
    active = new Map();
    buildContexts = new WeakMap();
    closed = false;
    stopRequest;
    constructor(options) {
        this.options = options;
    }
    prepareStart(candidate, signal) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        return this.options.supervisor.prepare(candidate, { startIfCold: true, signal });
    }
    static recover(error, previous, candidate, current) {
        return error instanceof PluginSystemError &&
            error.code === 'MINIAPP_PREPARATION_FAILED' &&
            current === candidate
            ? previous
            : current;
    }
    async prepare(input) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        throwIfAborted(input.signal);
        if (input.buildContext)
            this.recordBuildContext(input.snapshot, input.buildContext);
        const previous = this.active;
        const stopRequest = this.stopRequest;
        if (stopRequest) {
            this.stopRequest = undefined;
            return this.prepareStoppedPublication(input, previous, stopRequest);
        }
        const disablePluginIds = this.persistedDisableTargets(input);
        const failClosed = requiresFailClosedPublication(input, disablePluginIds);
        let state;
        try {
            const forcedPluginId = input.forceRuntimePublicationPluginId ?? input.preparedMiniAppStart?.candidate.pluginId;
            const publicationSnapshot = this.runtimePublicationSnapshot(input, previous, forcedPluginId);
            const accepted = listAcceptedMiniApps(publicationSnapshot);
            assertAcceptedTargets(accepted, input);
            state = await this.prepareState(previous, accepted, input.signal, {
                forcedPluginId,
                preparedStart: input.preparedMiniAppStart,
                disablePluginIds,
            });
            const rewritten = this.rewriteAcceptedSnapshot(publicationSnapshot, state.next, input.rosterSource ?? input.snapshot);
            return this.preparedPublication(state, rewritten, { failClosed });
        }
        catch (error) {
            if (state)
                await ignoreFailure(rollbackState(state));
            if (failClosed) {
                throw normalizeSupervisedPreparationError(error);
            }
            const fallback = this.fallback(input, previous);
            return inactivePublication(fallback, () => {
                if (this.active !== previous)
                    throw publicationError('PUBLICATION_SUPERSEDED');
            });
        }
    }
    async withStopRequest(input, operation) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        if (this.stopRequest)
            throw publicationError('MINIAPP_STOP_ALREADY_PENDING');
        const request = {
            pluginId: input.pluginId,
            ...(input.signal ? { signal: input.signal } : {}),
        };
        this.stopRequest = request;
        try {
            return await operation();
        }
        finally {
            if (this.stopRequest === request)
                this.stopRequest = undefined;
        }
    }
    hasPendingStopRequest() {
        return this.stopRequest !== undefined;
    }
    async recoverFailure(snapshot) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        const previous = this.active;
        const next = new Map(previous);
        const leases = [];
        const stopped = [];
        let changed = false;
        for (const [pluginId, item] of previous) {
            const status = this.options.supervisor
                .inspect(pluginId)
                .find((candidate) => candidate.pluginId === pluginId);
            if (acceptedRuntimeStillCurrent(status, item))
                continue;
            if (stoppedRecoveryAlreadyProjected(snapshot, status, item))
                continue;
            changed = true;
            if (item.mcpLease)
                leases.push(item.mcpLease);
            stopped.push(item);
            next.set(pluginId, stoppedAcceptedMiniApp(item, status?.active));
        }
        if (!changed)
            return undefined;
        if (this.active !== previous)
            throw publicationError('PUBLICATION_SUPERSEDED');
        this.active = next;
        await releaseRecoveryLeases(leases);
        return failureRecoveryPlan(snapshot, this.rewriteAcceptedSnapshot(snapshot, next, snapshot), stopped);
    }
    async prepareStoppedPublication(input, previous, request) {
        const accepted = previous.get(request.pluginId);
        if (!accepted)
            throw publicationError('MINIAPP_NOT_ACCEPTED');
        const authored = listAcceptedMiniApps(input.snapshot).find(({ candidate }) => candidate.pluginId === request.pluginId);
        if (!authored || !sameMiniAppCandidate(authored.candidate, accepted.candidate)) {
            throw publicationError('MINIAPP_REQUIRED_TARGET_NOT_ACCEPTED');
        }
        throwIfAborted(input.signal);
        let stop;
        try {
            stop = await this.options.supervisor.prepareStop(request.pluginId, {
                signal: request.signal ?? input.signal,
            });
            throwIfAborted(input.signal);
            assertStoppedTarget(accepted, stop.target);
            const next = new Map(previous);
            next.set(request.pluginId, {
                ...accepted,
                target: stop.target,
                stopTransition: stop,
                mcpLease: undefined,
                runtimeStopped: true,
            });
            const state = {
                previous,
                next,
                transitions: [],
                disables: [],
                stops: [stop],
            };
            const rewritten = this.rewriteAcceptedSnapshot(input.snapshot, next, input.rosterSource ?? input.snapshot);
            return this.preparedPublication(state, rewritten, { failClosed: true });
        }
        catch (error) {
            if (stop)
                await ignoreFailure(stop.rollback());
            throw normalizeSupervisedPreparationError(error);
        }
    }
    recordBuildContext(snapshot, context) {
        this.buildContexts.set(snapshot, context);
    }
    runtimePublicationSnapshot(input, previous, forcedPluginId) {
        const context = input.buildContext;
        if (!context)
            return input.snapshot;
        const requestedPluginId = forcedPluginId ?? input.requiredPluginId;
        const requestedTarget = requestedPluginId
            ? listEnabledMiniAppDefinitions(input.snapshot).find(({ candidate }) => candidate.pluginId === requestedPluginId)?.candidate
            : undefined;
        const buildContext = {
            input: buildSelectiveMiniAppInputs({
                available: context.input,
                availableSnapshot: input.snapshot,
                activePluginIds: new Set(previous.keys()),
                ...(requestedTarget ? { target: requestedTarget } : {}),
            }),
            options: context.options,
        };
        return this.buildRuntimeSnapshot(input, buildContext);
    }
    persistedDisableTargets(input) {
        if (input.requiredPluginId || input.forceRuntimePublicationPluginId)
            return new Set();
        const enabledDefinitionIds = new Set(listEnabledMiniAppDefinitions(input.snapshot).map(({ candidate }) => candidate.pluginId));
        return new Set(this.options.supervisor
            .inspect()
            .filter(({ pluginId, phase }) => phase !== 'inactive' && phase !== 'disabled' && !enabledDefinitionIds.has(pluginId))
            .map(({ pluginId }) => pluginId));
    }
    buildContext(snapshot) {
        return this.buildContexts.get(snapshot);
    }
    /** Reprojects a synchronous identity boundary through the currently accepted generations. */
    projectAcceptedSnapshot(snapshot, rosterSource = snapshot) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        if (snapshot.officialPackages.length > 0) {
            return this.rewriteAcceptedSnapshot(snapshot, this.active, rosterSource);
        }
        const visibleDefinitions = new Map(listEnabledMiniAppDefinitions(snapshot).map(({ candidate }) => [
            candidate.pluginId,
            candidate,
        ]));
        const visibleAccepted = new Map([...this.active].filter(([pluginId, item]) => {
            const candidate = visibleDefinitions.get(pluginId);
            return candidate && sameMiniAppCandidate(candidate, item.candidate);
        }));
        const localRoster = {
            ...rosterSource,
            enabledPlugins: Object.freeze(rosterSource.enabledPlugins.filter(({ source }) => source !== 'OFFICIAL')),
            turnCapabilities: {
                ...rosterSource.turnCapabilities,
                plugins: Object.freeze(rosterSource.turnCapabilities.plugins.filter(({ source }) => source !== 'official')),
            },
        };
        // Keep this.active intact: the queued scope publication still owns root and lease retirement.
        return this.rewriteAcceptedSnapshot(snapshot, visibleAccepted, localRoster);
    }
    /** Confirms that the accepted projection still names the Supervisor's running generation. */
    isAcceptedCandidateRunning(candidate) {
        if (this.closed)
            throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
        const accepted = this.active.get(candidate.pluginId);
        if (!accepted || !sameMiniAppCandidate(accepted.candidate, candidate))
            return false;
        const status = this.options.supervisor
            .inspect(candidate.pluginId)
            .find(({ pluginId }) => pluginId === candidate.pluginId);
        return status?.phase === 'active' && sameRunningGeneration(status.active, accepted.target);
    }
    isAcceptedMcpEndpointCurrent(pluginId, identity) {
        const accepted = this.active.get(pluginId);
        return Boolean(accepted &&
            accepted.candidate.mcpEndpoints.some(({ id }) => id === identity.endpointId) &&
            accepted.target.miniAppGeneration === identity.miniAppGeneration &&
            accepted.target.processGeneration === identity.processGeneration &&
            this.isAcceptedCandidateRunning(accepted.candidate));
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const active = this.active;
        this.active = new Map();
        await releaseLeases([...active.values()].flatMap(({ mcpLease }) => (mcpLease ? [mcpLease] : [])));
    }
    fallback(input, accepted) {
        const context = input.buildContext;
        const rosterSource = input.rosterSource ?? input.snapshot;
        if (!context) {
            return this.rewriteAcceptedSnapshot(input.currentSnapshot, accepted, rosterSource);
        }
        if (accepted.size === 0 &&
            context.input.localPackages.every(({ plugin }) => plugin.miniapp === undefined) &&
            context.input.officialPackages.every(({ plugin }) => plugin.miniapp === undefined)) {
            return this.rewriteAcceptedSnapshot(input.snapshot, accepted, rosterSource);
        }
        const definitions = new Map([...accepted].map(([pluginId, item]) => [pluginId, item.candidate]));
        const retention = { activePluginIds: new Set(accepted.keys()) };
        return this.rewriteAcceptedSnapshot(this.buildRuntimeSnapshot(input, {
            input: {
                ...context.input,
                // Official changes fail closed above. Unchanged cold packages must still
                // lose managed contributions when an unrelated local update falls back.
                officialPackages: context.input.officialPackages.map((candidate) => retainRuntimeMiniAppContribution(candidate, definitions, retention)
                    ? candidate
                    : ordinaryPackageContribution(candidate)),
                localPackages: mergeFallbackLocalPackages(context.input.localPackages, input.currentSnapshot, accepted),
            },
            options: context.options,
        }), accepted, rosterSource);
    }
    buildRuntimeSnapshot(input, context) {
        const snapshot = input.buildSnapshot(context.input, context.options);
        this.recordBuildContext(snapshot, context);
        return snapshot;
    }
    rewriteAcceptedSnapshot(snapshot, accepted, rosterSource = snapshot) {
        const rewritten = rewriteManagedMcpServers(snapshot, accepted);
        const rosteredSnapshot = withEnabledPluginRoster(rewritten, rosterSource);
        const context = this.buildContexts.get(snapshot);
        if (context)
            this.recordBuildContext(rosteredSnapshot, context);
        return rosteredSnapshot;
    }
    async prepareState(previous, accepted, signal, options) {
        const next = new Map();
        const transitions = [];
        const disables = [];
        try {
            for (const item of accepted) {
                throwIfAborted(signal);
                const reusable = this.reusableActive(previous, item, options.forcedPluginId);
                if (reusable) {
                    next.set(item.candidate.pluginId, reusable);
                    continue;
                }
                const preparationOptions = item.candidate.pluginId === options.forcedPluginId ? { forceStart: true } : undefined;
                const transition = options.preparedStart?.candidate.pluginId === item.candidate.pluginId
                    ? options.preparedStart
                    : await this.options.supervisor.prepare(item.candidate, preparationOptions);
                transitions.push(transition);
                throwIfAborted(signal);
                next.set(item.candidate.pluginId, {
                    ...item,
                    candidate: transition.candidate,
                    target: transition.target,
                    transition,
                });
            }
            const acceptedIds = new Set(accepted.map(({ candidate }) => candidate.pluginId));
            for (const pluginId of new Set([...previous.keys(), ...options.disablePluginIds])) {
                if (acceptedIds.has(pluginId))
                    continue;
                const disable = await this.options.supervisor.prepareDisable(pluginId);
                disables.push(disable);
                throwIfAborted(signal);
            }
            return { previous, next, transitions, disables, stops: [] };
        }
        catch (error) {
            await ignoreFailure(rollbackResources([...transitions, ...disables]));
            throw error;
        }
    }
    reusableActive(previous, item, forcedPluginId) {
        if (item.candidate.pluginId === forcedPluginId)
            return undefined;
        const current = previous.get(item.candidate.pluginId);
        return current && sameMiniAppCandidate(current.candidate, item.candidate) ? current : undefined;
    }
    preparedPublication(state, snapshot, options) {
        const previous = state.previous;
        let committed = false;
        let rolledBack = false;
        let retired = [];
        return {
            snapshot,
            ...(options.failClosed ? { failClosed: true } : {}),
            commit: async () => {
                if (rolledBack)
                    throw publicationError('MINIAPP_PUBLICATION_ROLLED_BACK');
                if (committed)
                    return;
                if (this.active !== previous)
                    throw publicationError('PUBLICATION_SUPERSEDED');
                const acquired = [];
                try {
                    for (const transition of state.transitions)
                        await transition.commit();
                    for (const disable of state.disables)
                        await disable.commit();
                    for (const stop of state.stops)
                        await stop.commit();
                    await acquireManagedMcpLeases(state.next, this.options.supervisor, acquired);
                    retired = [...previous].flatMap(([pluginId, item]) => state.next.get(pluginId) === item ? [] : [item]);
                    this.active = state.next;
                    committed = true;
                }
                catch (error) {
                    await ignoreFailure(releaseLeases([...acquired].reverse()));
                    await ignoreFailure(rollbackState(state));
                    throw error;
                }
            },
            rollback: async () => {
                if (rolledBack)
                    return;
                rolledBack = true;
                const nextLeases = [...state.next.values()].flatMap(({ mcpLease }) => mcpLease && !previousHasLease(previous, mcpLease) ? [mcpLease] : []);
                const stoppedLeases = committed
                    ? state.stops.flatMap(({ pluginId }) => {
                        const lease = previous.get(pluginId)?.mcpLease;
                        return lease ? [lease] : [];
                    })
                    : [];
                try {
                    await runAllFinally([
                        () => releaseLeases(nextLeases),
                        () => rollbackState(state),
                        () => releaseLeases(stoppedLeases),
                    ]);
                }
                finally {
                    if (committed)
                        this.active = state.stops.length > 0 ? state.next : previous;
                }
            },
            finalize: async () => {
                if (!committed || rolledBack)
                    return;
                await runAllFinally([
                    ...state.transitions.map((transition) => () => transition.finalize()),
                    ...state.disables.map((disable) => () => disable.finalize()),
                    ...state.stops.map((stop) => () => stop.finalize()),
                    () => releaseLeases(retired.flatMap(({ mcpLease }) => (mcpLease ? [mcpLease] : []))),
                ]);
            },
        };
    }
}
export function attachSupervisedMiniAppPublication(input) {
    if (input.initializeStarted) {
        throw new PluginSystemError('PUBLICATION_PARTICIPANT_LATE', 'Plugin publication participant must be attached before initialization');
    }
    if (input.current) {
        throw new PluginSystemError('PUBLICATION_PARTICIPANT_ALREADY_ATTACHED', 'Plugin publication participant is already attached');
    }
    return new SupervisedMiniAppPublicationParticipant({ supervisor: input.supervisor });
}
async function acquireManagedMcpLeases(next, supervisor, acquired) {
    for (const [pluginId, item] of next) {
        if (!item.transition ||
            item.runtimeStopped ||
            item.mcpLease ||
            item.candidate.mcpEndpoints.length === 0) {
            continue;
        }
        const lease = await supervisor.acquire({
            pluginId,
            expectedMiniAppGeneration: item.target.miniAppGeneration,
            ...(item.target.processGeneration
                ? { expectedProcessGeneration: item.target.processGeneration }
                : {}),
        });
        acquired.push(lease);
        next.set(pluginId, { ...item, mcpLease: lease });
    }
}
/**
 * Rebuilds one coherent input set: candidate ordinary capabilities are current,
 * while only the last-accepted MiniApp contribution and managed MCP endpoint remain.
 */
function mergeFallbackLocalPackages(candidates, currentSnapshot, accepted) {
    const currentMiniApps = currentAcceptedMiniAppProjections(currentSnapshot, accepted);
    const consumed = new Set();
    const merged = [];
    for (const candidate of candidates) {
        const current = currentMiniApps.get(candidate.plugin.name);
        const ordinary = ordinaryPackageContribution(candidate);
        if (!current) {
            merged.push(ordinary);
            continue;
        }
        const combined = mergeOrdinaryWithAcceptedMiniApp(ordinary, current);
        merged.push(current.rootPath === candidate.plugin.rootPath
            ? combined
            : retainAcceptedPackageIdentity(combined, current));
        consumed.add(current.name);
    }
    for (const current of currentMiniApps.values()) {
        if (!consumed.has(current.name))
            merged.push(acceptedMiniAppContribution(current));
    }
    return merged;
}
function retainAcceptedPackageIdentity(merged, current) {
    return {
        ...merged,
        plugin: {
            ...merged.plugin,
            // Candidate ordinary capabilities remain current, but a replacement root
            // cannot inherit the accepted Host service identity or name reservation.
            rootPath: current.plugin.rootPath,
            manifestPath: current.plugin.manifestPath,
        },
    };
}
function currentAcceptedMiniAppProjections(snapshot, accepted) {
    const projections = new Map();
    for (const projection of snapshot.localPlugins) {
        const expected = accepted.get(projection.name);
        if (!expected || !projection.enabled || !projection.plugin.miniapp)
            continue;
        const candidate = miniAppCandidateFromPackage({
            plugin: projection.plugin,
        });
        if (sameMiniAppCandidate(candidate, expected.candidate)) {
            projections.set(projection.name, projection);
        }
    }
    return projections;
}
function mergeOrdinaryWithAcceptedMiniApp(ordinary, current) {
    const miniapp = current.plugin.miniapp;
    if (!miniapp)
        return ordinary;
    const managedServers = miniAppManagedServerNames(miniapp);
    const acceptedServers = current.plugin.mcpServers.filter((server) => managedServers.has(server.name));
    return {
        ...ordinary,
        plugin: {
            ...ordinary.plugin,
            mcpServers: [
                ...ordinary.plugin.mcpServers.filter((server) => !managedServers.has(server.name)),
                ...acceptedServers,
            ],
            miniapp,
        },
    };
}
function acceptedMiniAppContribution(current) {
    const miniapp = current.plugin.miniapp;
    if (!miniapp)
        return { plugin: current.plugin, contentDigest: current.contentDigest };
    const managedServers = miniAppManagedServerNames(miniapp);
    return {
        contentDigest: current.contentDigest,
        plugin: {
            ...current.plugin,
            apps: [],
            skills: [],
            mcpServers: current.plugin.mcpServers.filter((server) => managedServers.has(server.name)),
        },
    };
}
function assertAcceptedTargets(accepted, input) {
    const acceptedIds = new Set(accepted.map(({ candidate }) => candidate.pluginId));
    if (input.requiredPluginId && !acceptedIds.has(input.requiredPluginId)) {
        throw publicationError('MINIAPP_REQUIRED_TARGET_NOT_ACCEPTED');
    }
    const forcedPluginId = input.forceRuntimePublicationPluginId ?? input.preparedMiniAppStart?.candidate.pluginId;
    if (forcedPluginId && !acceptedIds.has(forcedPluginId)) {
        throw publicationError('MINIAPP_FORCE_TARGET_NOT_ACCEPTED');
    }
    const prepared = input.preparedMiniAppStart?.candidate;
    if (prepared &&
        (prepared.pluginId !== input.requiredPluginId ||
            !accepted.some(({ candidate }) => sameMiniAppCandidate(candidate, prepared)))) {
        throw publicationError('MINIAPP_REQUIRED_TARGET_NOT_ACCEPTED');
    }
}
function requiresFailClosedPublication(input, disablePluginIds) {
    return (input.requiredPluginId !== undefined ||
        targetsMiniAppMutation(input.buildContext) ||
        changesOfficialMiniApp(input.currentSnapshot, input.snapshot, disablePluginIds));
}
function targetsMiniAppMutation(context) {
    return (context?.input.localPackages.some(({ plugin }) => plugin.miniapp !== undefined &&
        (context.options.localEnabledOverrides?.has(plugin.rootPath) === true ||
            context.options.excludedLocalRoots?.has(plugin.rootPath) === true)) === true);
}
function changesOfficialMiniApp(current, next, disablePluginIds) {
    const previousPackages = new Map(current.officialPackages.map((entry) => [entry.name, entry]));
    const nextPackages = new Map(next.officialPackages.map((entry) => [entry.name, entry]));
    return [...previousPackages.keys(), ...nextPackages.keys()].some((name) => {
        const previous = previousPackages.get(name);
        const candidate = nextPackages.get(name);
        if (!previous?.plugin?.miniapp && !candidate?.plugin?.miniapp && !disablePluginIds.has(name)) {
            return false;
        }
        return (!previous ||
            !candidate ||
            previous.rootPath !== candidate.rootPath ||
            previous.contentDigest !== candidate.contentDigest ||
            Boolean(previous.plugin?.miniapp &&
                candidate.plugin?.miniapp &&
                !sameMiniAppCandidate(miniAppCandidateFromPackage({ plugin: previous.plugin }), miniAppCandidateFromPackage({ plugin: candidate.plugin }))));
    });
}
function inactivePublication(snapshot, assertCurrent = () => undefined) {
    return {
        snapshot,
        commit: async () => assertCurrent(),
        rollback: async () => undefined,
        finalize: async () => undefined,
    };
}
function rewriteManagedMcpServers(snapshot, accepted) {
    const replacements = managedReplacements(accepted);
    const expected = managedEndpointKeys(accepted);
    const used = new Set();
    const mcpServers = snapshot.mcpServers.flatMap((entry) => {
        const key = managedKey(entry.pluginName, entry.server.name);
        const replacement = replacements.get(key);
        if (!replacement) {
            if (!expected.has(key))
                return [entry];
            used.add(key);
            return [];
        }
        used.add(key);
        const transport = {
            type: 'http',
            url: new URL(replacement.path, replacement.origin).toString(),
        };
        const rewritten = {
            ...entry,
            managedIdentity: {
                kind: 'miniapp',
                endpointId: replacement.endpointId,
                miniAppGeneration: replacement.miniAppGeneration,
                processGeneration: replacement.processGeneration,
            },
            server: {
                ...entry.server,
                resolvedServer: { ...entry.server.resolvedServer, transport },
                configJson: JSON.stringify(transport),
            },
        };
        return [rewritten];
    });
    if (used.size !== expected.size)
        throw publicationError('MINIAPP_MCP_SERVER_MISSING');
    return Object.freeze({ ...snapshot, mcpServers: Object.freeze(mcpServers) });
}
function managedReplacements(accepted) {
    const replacements = new Map();
    for (const [pluginId, item] of accepted) {
        if (item.candidate.mcpEndpoints.length === 0)
            continue;
        const origin = item.target.origin;
        const processGeneration = item.target.processGeneration;
        if (!origin || !processGeneration) {
            if (item.runtimeStopped)
                continue;
            throw publicationError('MINIAPP_MCP_RUNTIME_NOT_READY');
        }
        for (const declaration of item.candidate.mcpEndpoints) {
            replacements.set(managedKey(pluginId, declaration.id), {
                endpointId: declaration.id,
                path: declaration.path,
                origin,
                miniAppGeneration: item.target.miniAppGeneration,
                processGeneration,
            });
        }
    }
    return replacements;
}
function managedEndpointKeys(accepted) {
    const keys = new Set();
    for (const [pluginId, item] of accepted) {
        for (const declaration of item.candidate.mcpEndpoints) {
            keys.add(managedKey(pluginId, declaration.id));
        }
    }
    return keys;
}
function managedKey(pluginId, serverName) {
    return `${pluginId}\0${serverName}`;
}
function failureRecoveryPlan(published, candidate, stopped) {
    const stoppedByPlugin = new Map(stopped.map((item) => [item.candidate.pluginId, item]));
    const removedServers = published.mcpServers.filter((entry) => {
        const item = stoppedByPlugin.get(entry.pluginName);
        if (!item || !entry.managedIdentity)
            return false;
        const endpointIds = new Set(item.candidate.mcpEndpoints.map(({ id }) => id));
        return (endpointIds.has(entry.managedIdentity.endpointId) &&
            entry.managedIdentity.miniAppGeneration === item.target.miniAppGeneration &&
            (!item.target.processGeneration ||
                entry.managedIdentity.processGeneration === item.target.processGeneration));
    });
    const removedServerKeys = new Set(removedServers.map(({ pluginName, server }) => managedKey(pluginName, server.name)));
    const removedBindings = new Set(published.turnCapabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp' &&
        binding.pluginName !== undefined &&
        removedServerKeys.has(managedKey(binding.pluginName, binding.source))));
    const removedTools = new Set([...removedBindings].map(({ tool }) => tool));
    const exactCandidate = Object.freeze({
        ...candidate,
        mcpServers: Object.freeze(published.mcpServers.filter((entry) => !removedServers.includes(entry))),
    });
    return {
        candidateSnapshot: exactCandidate,
        ownerFailureSnapshot: withPluginMcpRuntime(exactCandidate, published.turnCapabilities.runtimeTools.filter((tool) => !removedTools.has(tool)), published.turnCapabilities.runtimeToolBindings.filter((binding) => !removedBindings.has(binding)), []),
    };
}
function snapshotHasManagedEndpoint(snapshot, item) {
    const names = new Set(item.candidate.mcpEndpoints.map(({ id }) => id));
    return snapshot.mcpServers.some(({ pluginName, server }) => pluginName === item.candidate.pluginId && names.has(server.name));
}
function acceptedRuntimeStillCurrent(status, item) {
    return status?.phase === 'active' && sameRunningGeneration(status.active, item.target);
}
function stoppedRecoveryAlreadyProjected(snapshot, status, item) {
    return Boolean(item.runtimeStopped &&
        status?.phase !== 'active' &&
        !snapshotHasManagedEndpoint(snapshot, item));
}
function previousHasLease(previous, lease) {
    return [...previous.values()].some((item) => item.mcpLease === lease);
}
async function rollbackState(state) {
    await rollbackResources([...state.transitions, ...state.disables, ...state.stops]);
}
async function rollbackResources(resources) {
    await runAllFinally([...resources].reverse().map((resource) => () => resource.rollback()));
}
function assertStoppedTarget(accepted, target) {
    if (target.pluginId === accepted.candidate.pluginId &&
        target.packageRoot === accepted.candidate.packageRoot &&
        target.packageDigest === accepted.candidate.packageDigest &&
        target.clientDigest === accepted.candidate.clientDigest &&
        target.surfacePath === accepted.candidate.surfacePath &&
        target.nodeDigest === accepted.candidate.nodeDigest &&
        target.lifecycle === accepted.candidate.lifecycle &&
        !target.processGeneration &&
        !target.origin) {
        return;
    }
    throw publicationError('MINIAPP_STOP_TARGET_INVALID');
}
async function releaseLeases(leases) {
    await runAllFinally(leases.map((lease) => () => lease.release()));
}
async function releaseRecoveryLeases(leases) {
    for (const lease of leases)
        await ignoreFailure(lease.release());
}
function stoppedAcceptedMiniApp(item, observed) {
    return {
        source: item.source,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.iconPath ? { iconPath: item.iconPath } : {}),
        candidate: item.candidate,
        runtimeStopped: true,
        target: {
            pluginId: item.candidate.pluginId,
            miniAppGeneration: observed?.miniAppGeneration ?? item.target.miniAppGeneration,
            packageRoot: item.candidate.packageRoot,
            packageDigest: item.candidate.packageDigest,
            clientDigest: item.candidate.clientDigest,
            surfacePath: item.candidate.surfacePath,
            nodeDigest: item.candidate.nodeDigest,
            lifecycle: item.candidate.lifecycle,
        },
    };
}
async function ignoreFailure(operation) {
    try {
        await operation;
    }
    catch {
        // Preserve the primary preparation or publication failure after cleanup.
    }
}
function throwIfAborted(signal) {
    if (!signal.aborted)
        return;
    throw signal.reason instanceof Error ? signal.reason : publicationError('DISPOSED');
}
function publicationError(code) {
    return new PluginSystemError(code, 'Mini App publication preparation failed');
}
function supervisedPreparationReasonCode(error) {
    return error instanceof PluginSystemError
        ? (error.reasonCode ?? error.code)
        : miniAppFailureReasonCode(error);
}
export function normalizeSupervisedPreparationError(error) {
    if (isSupervisedBusyError(error)) {
        return new PluginSystemError('BUSY', 'Mini App operation is busy', { cause: error });
    }
    const reasonCode = supervisedPreparationReasonCode(error);
    return new PluginSystemError('MINIAPP_PREPARATION_FAILED', 'Mini App publication preparation failed', { cause: error, ...(reasonCode ? { reasonCode } : {}) });
}
export function isSupervisedBusyError(error) {
    return miniAppBusyReason(error) !== undefined;
}
//# sourceMappingURL=publication.js.map