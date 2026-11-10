import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_PLUGIN_MARKETPLACE, samePluginId, } from '@mavis/shared';
import { PluginSystemError } from '../../errors.js';
import { deferred, findInstalledLocalPlugin, findLocalPlugin, ignoreFailure, runAllFinally, } from '../../plugin-system-helpers.js';
import { PluginPackageContractError } from '../package/package-contract.js';
import { hasSupportedCapability, readLinkedPluginPackage } from '../package/package-readers.js';
import { PluginReaderError } from '../package/reader-errors.js';
import { assertInstallablePluginId, installDirectoryName } from './install-directory.js';
/**
 * LOCAL Plugin mutations addressed by PluginId. Each one runs in the
 * PluginSystem operation queue and commits or rolls back with one snapshot
 * publication. Owned roots live below `${dataDir}/plugins`; linked roots are
 * registered folders that are only ever read.
 */
export class LocalPluginLifecycle {
    host;
    constructor(host) {
        this.host = host;
    }
    async setEnabled(selector, enabled) {
        await this.host.admit();
        return this.host.runExclusive(async () => {
            const inputs = await this.host.readInputs();
            const target = findLocalPlugin(this.host.project(inputs), selector);
            if (!target)
                throw new PluginSystemError('PLUGIN_NOT_FOUND', 'local Plugin is not installed');
            const { rootPath } = target;
            const prior = this.host.repository.isLocalPluginEnabled(rootPath);
            const next = this.host.buildPublication(inputs, {
                localEnabledOverrides: new Map([[rootPath, enabled]]),
            });
            await this.host.publish(next, {
                completion: deferred(),
                commit: async () => this.host.repository.setLocalPluginEnabled(rootPath, enabled),
                rollback: async () => this.host.repository.setLocalPluginEnabled(rootPath, prior),
            });
            this.host.recordMutation();
            return { installExists: true, enabled };
        });
    }
    async uninstallLocal(selector) {
        await this.remove(selector);
        return { installExists: false, enabled: false };
    }
    uninstall(id) {
        return this.remove({ name: id.name, marketplace: id.marketplace });
    }
    async acceptOwned(prepared, options) {
        return (await this.acceptPreparedPackage(prepared, options)).installed;
    }
    /**
     * Accepts a staged package as an owned root and publishes it. With
     * `replacing`, the installed copy of the same PluginId is staged out and the
     * new package takes its directory and enabled state in the same publication;
     * a failure restores both. Always discards the staging container.
     */
    async acceptPreparedPackage(prepared, options) {
        try {
            assertInstallablePluginId(options.id);
            if (!hasSupportedCapability(prepared.plugin)) {
                throw new PluginSystemError('PLUGIN_NO_SUPPORTED_CAPABILITY', 'Plugin contains no valid App, Skill, MCP, Hook, Agent, or Mini App capability');
            }
            await this.host.admit();
            return await this.host.runExclusive(() => this.acceptExclusive(prepared, options));
        }
        finally {
            await ignoreFailure(prepared.discard());
        }
    }
    async link(input) {
        assertInstallablePluginId(input.id);
        await this.host.admit();
        return this.host.runExclusive(async () => {
            const rootPath = await canonicalLinkRoot(input.rootPath, this.host.dataDir);
            await assertLinkablePackage(rootPath, this.host.dataDir, input.manifest);
            const links = this.host.packageStorage.links;
            const records = await links.read();
            const current = this.host.project(await this.host.readInputs());
            if (findInstalledLocalPlugin(current, input.id) ||
                records.some((record) => samePluginId(record.id, input.id) || record.rootPath === rootPath)) {
                throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin is already installed');
            }
            const record = {
                id: input.id,
                rootPath,
                ...(input.manifest ? { manifest: input.manifest } : {}),
            };
            await links.write([...records, record]);
            try {
                const nextInputs = await this.host.readInputs();
                const linked = nextInputs.localPackages.find((entry) => entry.plugin.rootPath === rootPath && !entry.unavailableReason);
                if (!linked) {
                    throw new PluginSystemError('PLUGIN_IMPORT_INVALID', 'Linked Plugin was not readable');
                }
                await this.host.publish(this.host.buildPublication(nextInputs, {}), {
                    completion: deferred(),
                    commit: async () => this.host.repository.setLocalPluginEnabled(rootPath, true),
                    rollback: () => links.write(records),
                });
                this.host.recordMutation();
                return installedFromInput({ ...linked, id: input.id, ownership: 'linked' }, true);
            }
            catch (error) {
                await ignoreFailure(links.write(records));
                throw error;
            }
            finally {
                this.host.linksChanged();
            }
        });
    }
    async listInstalled() {
        const snapshot = await this.host.readProjection();
        return snapshot.localPlugins.map(installedLocalPlugin);
    }
    /** Returns whether a Plugin or a stale link registration was removed. */
    async remove(selector) {
        await this.host.admit();
        return this.host.runExclusive(async () => {
            const inputs = await this.host.readInputs();
            const target = findLocalPlugin(this.host.project(inputs), selector);
            if (target) {
                await this.publishRemoval(inputs, target);
                this.host.pluginRemoved(target.id);
                return true;
            }
            if (selector.marketplace === undefined)
                return false;
            const id = { name: selector.name, marketplace: selector.marketplace };
            const forgotten = await this.forgetLink(id);
            if (forgotten)
                this.host.pluginRemoved(id);
            return forgotten;
        });
    }
    async publishRemoval(inputs, target) {
        const { rootPath } = target;
        const prior = this.host.repository.isLocalPluginEnabled(rootPath);
        const removal = target.ownership === 'linked'
            ? await this.linkRemoval(target.id)
            : this.ownedRemoval(rootPath);
        const next = this.host.buildPublication(inputs, { excludedLocalRoots: new Set([rootPath]) });
        try {
            await this.host.publish(next, {
                completion: deferred(),
                commit: async () => {
                    await removal.commit();
                    this.host.repository.setLocalPluginEnabled(rootPath, true);
                },
                rollback: async () => {
                    try {
                        this.host.repository.setLocalPluginEnabled(rootPath, prior);
                    }
                    finally {
                        await removal.rollback();
                    }
                },
                finalize: removal.finalize,
            });
            this.host.recordMutation();
        }
        finally {
            if (target.ownership === 'linked')
                this.host.linksChanged();
        }
    }
    /** Owned roots move to the uninstall quarantine and are deleted after publication. */
    ownedRemoval(rootPath) {
        let staged;
        return {
            commit: async () => {
                staged = await this.host.packageStorage.stageAcceptedLocalRoot(rootPath);
            },
            rollback: async () => staged?.restore(),
            finalize: async () => staged?.discard(),
        };
    }
    /** Linked roots only lose their registration; their folder is never touched. */
    async linkRemoval(id) {
        const links = this.host.packageStorage.links;
        const previous = await links.read();
        return {
            commit: () => links.write(previous.filter((record) => !samePluginId(record.id, id))),
            rollback: () => links.write(previous),
            finalize: async () => undefined,
        };
    }
    /** A registration whose folder never produced a readable Plugin is not in the snapshot. */
    async forgetLink(id) {
        const links = this.host.packageStorage.links;
        const records = await links.read();
        const remaining = records.filter((record) => !samePluginId(record.id, id));
        if (remaining.length === records.length)
            return false;
        await links.write(remaining);
        this.host.recordMutation();
        this.host.linksChanged();
        return true;
    }
    async acceptExclusive(prepared, options) {
        const { id } = options;
        const replaced = await this.replacementTarget(id, options.replacing === true);
        // The replacement keeps the installed directory, so its enabled state and
        // every other root-keyed record carry over unchanged.
        const enabled = replaced ? this.host.repository.isLocalPluginEnabled(replaced.rootPath) : true;
        const moves = new PackageMoves(this.host.packageStorage);
        try {
            const rootPath = await moves.moveIntoPlace(prepared.stagingRoot, replaced ? path.basename(replaced.rootPath) : installDirectoryName(id), replaced?.rootPath);
            const nextInputs = await this.host.readInputs();
            const imported = nextInputs.localPackages.find((entry) => entry.plugin.rootPath === rootPath);
            if (!imported || !samePluginId(imported.id ?? localId(imported.plugin.name), id)) {
                throw new PluginSystemError('PLUGIN_IMPORT_INVALID', 'Imported Plugin was not readable');
            }
            await this.host.publish(this.host.buildPublication(nextInputs, {
                localEnabledOverrides: new Map([[rootPath, enabled]]),
            }), {
                completion: deferred(),
                commit: async () => this.host.repository.setLocalPluginEnabled(rootPath, enabled),
                rollback: () => moves.restore(),
                finalize: () => moves.discardReplaced(),
            });
            this.host.recordMutation();
            return {
                installed: installedFromInput({ ...imported, id, ownership: 'owned' }, enabled),
                plugin: imported.plugin,
            };
        }
        catch (error) {
            await ignoreFailure(moves.restore());
            throw error;
        }
    }
    /** The installed copy a replacement swaps out; a fresh install must not collide. */
    async replacementTarget(id, replacing) {
        const current = this.host.project(await this.host.readInputs());
        const existing = findInstalledLocalPlugin(current, id);
        if (!replacing) {
            if (existing || (await this.isLinked(id))) {
                throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin is already installed');
            }
            return undefined;
        }
        if (!existing)
            throw new PluginSystemError('PLUGIN_NOT_FOUND', 'local Plugin is not installed');
        if (existing.ownership === 'linked') {
            throw new PluginSystemError('PLUGIN_UPDATE_UNSUPPORTED', 'linked Plugins load in place');
        }
        return existing;
    }
    async isLinked(id) {
        return (await this.host.packageStorage.links.read()).some((record) => samePluginId(record.id, id));
    }
}
/**
 * Directory moves of one acceptance: the replaced copy goes to the uninstall
 * quarantine, then the staged package takes the target directory. `restore`
 * undoes both in reverse order and is safe to call more than once.
 */
class PackageMoves {
    storage;
    staged;
    accepted;
    constructor(storage) {
        this.storage = storage;
    }
    async moveIntoPlace(stagingRoot, directoryName, replacedRoot) {
        if (replacedRoot)
            this.staged = await this.storage.stageAcceptedLocalRoot(replacedRoot);
        this.accepted = await this.storage.acceptImportedLocalRoot(stagingRoot, directoryName);
        return this.accepted.rootPath;
    }
    restore() {
        return runAllFinally([() => this.accepted?.restore(), () => this.staged?.restore()]);
    }
    async discardReplaced() {
        await this.staged?.discard();
    }
}
/** Installer view of a projected local Plugin. */
export function installedLocalPlugin(plugin) {
    return {
        id: plugin.id,
        ownership: plugin.ownership,
        rootPath: plugin.rootPath,
        manifestName: plugin.name,
        ...(plugin.version ? { version: plugin.version } : {}),
        contentDigest: plugin.contentDigest,
        enabled: plugin.enabled,
        ...(plugin.unavailableReason ? { unavailableReason: plugin.unavailableReason } : {}),
    };
}
function installedFromInput(entry, enabled) {
    return {
        id: entry.id,
        ownership: entry.ownership,
        rootPath: entry.plugin.rootPath,
        manifestName: entry.plugin.name,
        ...(entry.plugin.version ? { version: entry.plugin.version } : {}),
        contentDigest: entry.contentDigest,
        enabled,
    };
}
function localId(name) {
    return { name, marketplace: LOCAL_PLUGIN_MARKETPLACE };
}
/** A linked root is an existing absolute folder outside the owned Plugin directory. */
async function canonicalLinkRoot(rootPath, dataDir) {
    if (!path.isAbsolute(rootPath)) {
        throw new PluginSystemError('PLUGIN_LINK_INVALID', 'linked Plugin folder must be absolute');
    }
    let canonical;
    try {
        canonical = await realpath(rootPath);
    }
    catch {
        throw new PluginSystemError('PLUGIN_SOURCE_MISSING', 'linked Plugin folder does not exist');
    }
    const ownedRoot = path.join(dataDir, 'plugins');
    let canonicalOwnedRoot = path.resolve(ownedRoot);
    try {
        canonicalOwnedRoot = await realpath(ownedRoot);
    }
    catch {
        // Not created yet: the resolved path is the future owned root.
    }
    if (overlaps(canonicalOwnedRoot, canonical)) {
        throw new PluginSystemError('PLUGIN_LINK_INVALID', 'linked Plugin folder overlaps the installed Plugin directory');
    }
    return canonical;
}
/** The folder must read as a Plugin before it is registered. */
async function assertLinkablePackage(rootPath, dataDir, manifest) {
    let linked;
    try {
        linked = await readLinkedPluginPackage(rootPath, {
            dataDir,
            ...(manifest ? { declaredManifest: manifest } : {}),
        });
    }
    catch (error) {
        throw normalizeReaderError(error);
    }
    if (!hasSupportedCapability(linked.plugin)) {
        throw new PluginSystemError('PLUGIN_NO_SUPPORTED_CAPABILITY', 'Plugin contains no valid App, Skill, MCP, Hook, Agent, or Mini App capability');
    }
}
function overlaps(left, right) {
    const inside = (root, candidate) => {
        const relative = path.relative(root, candidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    return inside(left, right) || inside(right, left);
}
function normalizeReaderError(error) {
    if (error instanceof PluginReaderError || error instanceof PluginPackageContractError) {
        return new PluginSystemError(error.code, error.message);
    }
    return error;
}
//# sourceMappingURL=local-plugin-lifecycle.js.map