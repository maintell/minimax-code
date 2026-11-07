import { classifyMiniAppCandidateChange } from '../../../../miniapp/index.js';
import { PluginSystemError } from '../../../errors.js';
import { isColdMiniAppTarget, listEnabledMiniAppDefinitions, miniAppCandidateFromPackage, sameMiniAppCandidate, sameRunningGeneration, } from './candidate.js';
/** Keeps authored definitions discoverable while removing every cold runtime contribution. */
export function projectColdMiniAppPublication(input) {
    const localPackages = input.buildContext.input.localPackages.map(ordinaryPackageContribution);
    const officialPackages = input.buildContext.input.officialPackages.map(ordinaryPackageContribution);
    const projected = input.buildSnapshot({ ...input.buildContext.input, localPackages, officialPackages }, input.buildContext.options);
    return withEnabledPluginRoster(projected, input.snapshot);
}
/**
 * Rebuilds a targeted publication from the accepted runtime context. The fresh
 * catalog contributes only the requested package; every unrelated input remains
 * exactly as it was in the current publication.
 */
export function buildTargetedMiniAppInputs(input) {
    const validatedTarget = listEnabledMiniAppDefinitions(input.availableSnapshot).find(({ candidate }) => sameMiniAppCandidate(candidate, input.target));
    if (!validatedTarget)
        throw invalidTargetError();
    const matchesTarget = (candidate) => candidate.plugin.name === input.target.pluginId &&
        candidate.plugin.rootPath === input.target.packageRoot &&
        candidate.plugin.miniapp !== undefined &&
        sameMiniAppCandidate(miniAppCandidateFromPackage(candidate), input.target);
    const officialTarget = input.available.officialPackages.find(matchesTarget);
    if (officialTarget) {
        return {
            ...input.base,
            officialPackages: replaceTargetPackage(input.base.officialPackages, officialTarget),
        };
    }
    const targetPackage = input.available.localPackages.find(matchesTarget);
    if (!targetPackage)
        throw invalidTargetError();
    return {
        ...input.base,
        localPackages: replaceTargetPackage(input.base.localPackages, targetPackage),
    };
}
function replaceTargetPackage(packages, target) {
    let replaced = false;
    const next = [];
    for (const current of packages) {
        if (current.plugin.name !== target.plugin.name) {
            next.push(current);
            continue;
        }
        if (!replaced)
            next.push(target);
        replaced = true;
    }
    if (!replaced)
        next.push(target);
    return next;
}
export function buildSelectiveMiniAppInputs(input) {
    const definitions = new Map(listEnabledMiniAppDefinitions(input.availableSnapshot).map(({ candidate }) => [
        candidate.pluginId,
        candidate,
    ]));
    const target = input.target;
    if (target &&
        ![...definitions.values()].some((candidate) => sameMiniAppCandidate(candidate, target))) {
        throw invalidTargetError();
    }
    const localPackages = input.available.localPackages.map((candidate) => retainRuntimeMiniAppContribution(candidate, definitions, input)
        ? candidate
        : ordinaryPackageContribution(candidate));
    const officialPackages = input.available.officialPackages.map((candidate) => retainRuntimeMiniAppContribution(candidate, definitions, input)
        ? candidate
        : ordinaryPackageContribution(candidate));
    return { ...input.available, localPackages, officialPackages };
}
export function retainRuntimeMiniAppContribution(candidate, definitions, input) {
    const definition = definitions.get(candidate.plugin.name);
    if (!definition || !candidate.plugin.miniapp)
        return false;
    if (candidate.plugin.rootPath !== definition.packageRoot)
        return false;
    if (!sameMiniAppCandidate(miniAppCandidateFromPackage(candidate), definition))
        return false;
    return (input.activePluginIds.has(candidate.plugin.name) ||
        Boolean(input.target && sameMiniAppCandidate(definition, input.target)));
}
export function ordinaryPackageContribution(candidate) {
    const miniapp = candidate.plugin.miniapp;
    if (!miniapp)
        return candidate;
    const managedServers = miniAppManagedServerNames(miniapp);
    const plugin = { ...candidate.plugin };
    delete plugin.miniapp;
    return {
        ...candidate,
        plugin: {
            ...plugin,
            mcpServers: plugin.mcpServers.filter((server) => !managedServers.has(server.name)),
        },
    };
}
/**
 * Publishes `rosterSource`'s enabled-plugin roster on `runtimeSnapshot`. An official plugin named
 * in `officialOverrides` takes its roster entries from the mapped snapshot instead.
 */
export function withEnabledPluginRoster(runtimeSnapshot, rosterSource, officialOverrides = new Map()) {
    const enabledPlugins = overrideOfficialRosterEntries(rosterSource.enabledPlugins, officialOverrides, (entry) => entry.source === 'OFFICIAL', (snapshot) => snapshot.enabledPlugins);
    const turnPlugins = overrideOfficialRosterEntries(rosterSource.turnCapabilities.plugins, officialOverrides, (entry) => entry.source === 'official', (snapshot) => snapshot.turnCapabilities.plugins);
    if (runtimeSnapshot.enabledPlugins === enabledPlugins &&
        runtimeSnapshot.turnCapabilities.plugins === turnPlugins) {
        return runtimeSnapshot;
    }
    return Object.freeze({
        ...runtimeSnapshot,
        enabledPlugins,
        turnCapabilities: Object.freeze({
            ...runtimeSnapshot.turnCapabilities,
            plugins: turnPlugins,
        }),
    });
}
function overrideOfficialRosterEntries(entries, overrides, isOfficial, rosterOf) {
    if (overrides.size === 0)
        return entries;
    return Object.freeze(entries.flatMap((entry) => {
        const source = isOfficial(entry) ? overrides.get(entry.name) : undefined;
        if (!source)
            return [entry];
        return rosterOf(source).filter((item) => item.name === entry.name && isOfficial(item));
    }));
}
export function miniAppManagedServerNames(miniapp) {
    return new Set(miniapp.mcpEndpoints.map(({ server }) => server));
}
function invalidTargetError() {
    return new PluginSystemError('MINIAPP_TARGET_DEFINITION_MISSING', 'Mini App publication preparation failed');
}
/** Supervisor phases in which a Mini App counts as "in use" for marketplace updates. */
const RUNNING_PHASES = new Set(['active', 'starting', 'preparing']);
/**
 * A running official Mini App whose new package needs a process restart keeps its accepted
 * package in this publication (Node, client, managed MCP and Skills together). The user applies
 * the update explicitly, or it is adopted once the service stops; the rest of the catalog
 * publishes normally. Local packages keep their existing behaviour.
 *
 * Returns the build context with the held packages swapped in and the accepted entries that were
 * held, or `undefined` when none is held.
 */
export function heldOfficialBuildContext(input, previous, supervisor) {
    const context = input.buildContext;
    if (!context || previous.size === 0)
        return undefined;
    const forcedPluginId = input.forceRuntimePublicationPluginId ?? input.preparedMiniAppStart?.candidate.pluginId;
    const held = [];
    const entries = [];
    for (const definition of listEnabledMiniAppDefinitions(input.snapshot)) {
        const pluginId = definition.candidate.pluginId;
        const current = previous.get(pluginId);
        if (!current || pluginId === forcedPluginId || pluginId === input.requiredPluginId)
            continue;
        const accepted = heldOfficialPackage(input.currentSnapshot, current, definition, supervisor);
        if (!accepted)
            continue;
        held.push(accepted);
        entries.push(current);
    }
    if (held.length === 0)
        return undefined;
    return {
        context: {
            input: {
                ...context.input,
                officialPackages: held.reduce((packages, item) => replaceTargetPackage(packages, item), context.input.officialPackages),
            },
            options: context.options,
        },
        entries,
    };
}
/**
 * The hold is decided before the publication gate. A held runtime that stopped, failed or moved
 * to another generation since then must not be committed on its old package: the publication is
 * superseded and the next attempt adopts the new package cold.
 */
export function heldEntriesStillRunning(held, supervisor) {
    return !held || held.entries.every((entry) => isAcceptedEntryRunning(entry, supervisor));
}
function heldOfficialPackage(currentSnapshot, current, definition, supervisor) {
    if (current.source !== 'official' ||
        !isAcceptedEntryRunning(current, supervisor) ||
        classifyMiniAppCandidateChange(current.candidate, definition.candidate) !== 'restart') {
        return undefined;
    }
    const accepted = currentSnapshot.officialPackages.find((entry) => entry.name === current.candidate.pluginId && entry.rootPath === current.candidate.packageRoot);
    return accepted?.plugin
        ? { plugin: accepted.plugin, contentDigest: accepted.contentDigest }
        : undefined;
}
function isAcceptedEntryRunning(entry, supervisor) {
    const pluginId = entry.candidate.pluginId;
    const status = supervisor.inspect(pluginId).find((item) => item.pluginId === pluginId);
    if (!status || !RUNNING_PHASES.has(status.phase))
        return false;
    return status.phase !== 'active' || sameRunningGeneration(status.active, entry.target);
}
/** Accepts a definition at the generation a Supervisor transition prepared for it. */
export function acceptedFromTransition(item, transition) {
    return {
        ...item,
        candidate: transition.candidate,
        target: transition.target,
        ...(transition.loopbackToken ? { loopbackToken: transition.loopbackToken } : {}),
        // A stopped official Mini App adopts the new definition cold: no managed endpoint
        // is published and no MCP lease is taken until the user opens it again.
        ...(item.source === 'official' &&
            isColdMiniAppTarget(transition.target, transition.loopbackToken)
            ? { runtimeStopped: true }
            : {}),
        transition,
    };
}
/** Whether an official Mini App package appears, disappears or changes between two snapshots. */
export function changesOfficialMiniApp(current, next, disablePluginIds) {
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
/**
 * A caller-supplied roster (targeted activation passes the latest catalog) can name a newer
 * package than one this publication keeps accepted, such as a held official Mini App. Those
 * plugins keep the roster entries of the package that is actually published.
 */
export function divergentRosterOverrides(input, accepted) {
    const rosterSource = input.rosterSource;
    const overrides = new Map();
    if (!rosterSource)
        return overrides;
    for (const [pluginId, item] of accepted) {
        if (item.source !== 'official')
            continue;
        const rostered = rosterSource.officialPackages.find(({ name }) => name === pluginId);
        if (rostered && rostered.rootPath !== item.candidate.packageRoot) {
            overrides.set(pluginId, input.snapshot);
        }
    }
    return overrides;
}
/** Retains every accepted official root; returns the releases for roots that left the set. */
export function retainAcceptedOfficialRoots(retained, next, options) {
    const retain = options.retainOfficialPackage;
    if (!retain)
        return [];
    const released = [];
    for (const [pluginId, item] of next) {
        if (item.source !== 'official')
            continue;
        const packageRoot = item.candidate.packageRoot;
        const current = retained.get(pluginId);
        if (current?.packageRoot === packageRoot)
            continue;
        if (current)
            released.push(current.release);
        retained.set(pluginId, { packageRoot, release: retain(packageRoot) });
    }
    for (const [pluginId, current] of retained) {
        if (next.has(pluginId))
            continue;
        released.push(current.release);
        retained.delete(pluginId);
    }
    return released;
}
export async function releaseOfficialRoots(releases) {
    await Promise.all(releases.map((release) => release()));
}
/** Releases every retained root, e.g. when the participant closes. */
export async function releaseRetainedOfficialRoots(retained) {
    const releases = [...retained.values()].map(({ release }) => release);
    retained.clear();
    await releaseOfficialRoots(releases);
}
//# sourceMappingURL=projection.js.map