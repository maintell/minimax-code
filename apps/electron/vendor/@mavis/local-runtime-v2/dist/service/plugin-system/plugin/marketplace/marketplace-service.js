import { createHash } from 'node:crypto';
import { isBuiltInPluginMarketplace, pluginIdKey, samePluginId, } from '@mavis/shared';
import { PluginSystemError } from '../../errors.js';
import { settleInBackground } from '../../plugin-system-helpers.js';
import { pathObjectShas, resolveHead } from '../source/git-checkout.js';
import { AutoUpdater } from './auto-updater.js';
import { entryNameKey, findCatalogEntry, readCatalog, } from './catalog.js';
import { errorCodeOf, MarketplaceErrorCode, marketplaceError, normalizeMarketplaceError, } from './errors.js';
import { changedFiles, digestFiles, InstallRecords } from './installs.js';
import { declaredComponentPaths, EntryMaterializer, inspectRelativeEntry, manifestDependencies, manifestVersion, probeManifest, } from './materializer.js';
import { MarketplaceRegistry, resolveMarketplaceSource, } from './registry.js';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const REMOTE_HEAD_TIMEOUT_MS = 30_000;
export function createPluginMarketplaceService(options) {
    return new MarketplaceService(options);
}
/**
 * Discovery and acquisition for user-added marketplaces. Installed Plugins are
 * ordinary LOCAL Plugins: every install, update, and uninstall goes through
 * the LocalPluginInstaller port. Mutations run one at a time. Every public
 * operation checks the release gate first, so a disabled build never reaches
 * Git or the marketplace state directory.
 */
class MarketplaceService {
    options;
    now;
    registry;
    installs;
    materializer;
    autoUpdater;
    exclusive = createSerialQueue();
    started = false;
    disposed = false;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.registry = new MarketplaceRegistry({ dataDir: options.dataDir, now: this.now });
        this.installs = new InstallRecords(this.registry.stateDir);
        this.materializer = new EntryMaterializer(options.dataDir);
        this.autoUpdater = new AutoUpdater({ candidates: () => this.autoSyncCandidates(), sync: (name) => this.autoSync(name) }, { now: this.now, onError: (error) => this.reportBackgroundFailure(error) });
    }
    async list() {
        this.assertEnabled();
        const [records, installed] = await Promise.all([this.registry.list(), this.installedOrEmpty()]);
        return Promise.all(records.map((record) => this.view(record, installed)));
    }
    async add(input) {
        this.assertUsable();
        let source;
        try {
            source = await resolveMarketplaceSource(input);
        }
        catch (error) {
            throw normalizeMarketplaceError(error);
        }
        return this.exclusive(async () => {
            const startedAt = this.now();
            const fields = { kind: source.kind, ...hostField(source) };
            try {
                const { record, alreadyAdded } = await this.registry.add(source);
                this.observe('add', { result: 'ok', kind: source.kind }, startedAt);
                this.options.logger.info('plugin marketplace added', {
                    ...fields,
                    marketplace: record.name,
                    alreadyAdded,
                });
                return {
                    marketplace: await this.view(record, await this.installedOrEmpty()),
                    alreadyAdded,
                };
            }
            catch (error) {
                const code = errorCodeOf(error);
                this.observe('add', { result: 'error', kind: source.kind, code }, startedAt);
                this.options.logger.warn('plugin marketplace add failed', { ...fields, code });
                throw normalizeMarketplaceError(error);
            }
        });
    }
    async refresh(name) {
        this.assertUsable();
        const names = name === undefined ? (await this.registry.list()).map((item) => item.name) : [name];
        const refreshed = [];
        for (const each of names) {
            const record = await this.exclusive(async () => name !== undefined || (await this.registry.find(each))
                ? this.refreshOne(each, 'manual')
                : undefined);
            if (record)
                refreshed.push(record);
        }
        const installed = await this.installedOrEmpty();
        return Promise.all(refreshed.map((record) => this.view(record, installed)));
    }
    async setAutoUpdate(name, autoUpdate) {
        this.assertUsable();
        const record = await this.exclusive(() => this.registry.setAutoUpdate(name, autoUpdate));
        return this.view(record, await this.installedOrEmpty());
    }
    async remove(name) {
        this.assertUsable();
        return this.exclusive(async () => {
            if (!(await this.registry.find(name)))
                throw notFound();
            const installed = (await this.options.installer.listInstalled()).filter((plugin) => plugin.id.marketplace === name);
            const uninstalled = [];
            for (const plugin of installed) {
                const code = await this.uninstallFailure(plugin.id);
                if (code) {
                    // The marketplace stays so the user can retry; nothing else is touched.
                    this.observe('remove', { result: 'error', code }, this.now());
                    return { removed: false, uninstalled, failed: [{ id: plugin.id, code }] };
                }
                uninstalled.push(plugin.id);
            }
            await this.registry.forget(name);
            this.observe('remove', { result: 'ok' }, this.now());
            this.options.logger.info('plugin marketplace removed', {
                marketplace: name,
                uninstalled: uninstalled.length,
            });
            return { removed: true, uninstalled, failed: [] };
        });
    }
    async listEntries(name, query) {
        this.assertEnabled();
        const record = await this.registry.find(name);
        if (!record)
            throw notFound();
        const market = await this.loadMarket(record);
        const matching = filterEntries(market.catalog?.entries ?? [], query);
        const offset = cursorOffset(query.cursor);
        const end = offset + pageSize(query.limit);
        const resolved = await this.resolveEntries(market, matching.slice(offset, end));
        const entries = await Promise.all(resolved.map((item) => this.entryView(market, item)));
        const hasMore = end < matching.length;
        return {
            entries,
            hasMore,
            total: matching.length,
            ...(hasMore ? { nextCursor: String(end) } : {}),
        };
    }
    async getEntry(id) {
        this.assertEnabled();
        const record = await this.registry.find(id.marketplace);
        const market = record ? await this.loadMarket(record) : undefined;
        const entry = market?.catalog ? findCatalogEntry(market.catalog, id.name) : undefined;
        if (!market || !entry)
            return undefined;
        return this.entryView(market, await this.resolveEntry(market, entry));
    }
    async install(id) {
        this.assertUsable();
        return this.exclusive(async () => {
            const startedAt = this.now();
            try {
                const plugin = await this.installEntry(id);
                this.observe('install', { result: 'ok', mode: plugin.ownership }, startedAt);
                this.options.logger.info('plugin marketplace entry installed', {
                    marketplace: id.marketplace,
                    mode: plugin.ownership,
                });
                return plugin;
            }
            catch (error) {
                const code = errorCodeOf(error);
                this.observe('install', { result: 'error', code }, startedAt);
                this.options.logger.warn('plugin marketplace entry install failed', {
                    marketplace: id.marketplace,
                    code,
                });
                throw normalizeMarketplaceError(error);
            }
        });
    }
    async update(id) {
        this.assertUsable();
        return this.exclusive(async () => {
            const startedAt = this.now();
            try {
                // A manual update always runs and overwrites local edits (it reports them).
                const result = await this.replaceInstalled(await this.updateTarget(id));
                this.observe('update', { result: 'ok', trigger: 'manual' }, startedAt);
                return result;
            }
            catch (error) {
                const code = errorCodeOf(error);
                this.observe('update', { result: 'error', trigger: 'manual', code }, startedAt);
                throw normalizeMarketplaceError(error);
            }
        });
    }
    async describeInstalled(plugins) {
        const states = new Map();
        // Disabled builds describe nothing: installed Plugins read as plain LOCAL ones.
        if (!this.options.isEnabled())
            return states;
        const groups = groupByMarketplace(plugins.filter((plugin) => !isBuiltInPluginMarketplace(plugin.id.marketplace)));
        if (groups.size === 0)
            return states;
        const [records, installRecords] = await Promise.all([
            this.registry.list(),
            this.installs.read(plugins),
        ]);
        for (const [marketplace, group] of groups) {
            const record = records.find((item) => item.name === marketplace);
            const market = record ? await this.loadMarket(record) : undefined;
            for (const [key, state] of await this.describeGroup(market, group, installRecords)) {
                states.set(key, state);
            }
        }
        return states;
    }
    start() {
        if (this.started || this.disposed)
            return;
        this.started = true;
        // Snapshots left by an interrupted refresh or removal; a disabled build
        // leaves the state directory untouched.
        if (this.options.isEnabled()) {
            settleInBackground(this.exclusive(() => this.registry.collectGarbage()));
        }
        // Each tick re-reads the gate, so sync resumes when the flag turns on.
        this.autoUpdater.start();
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        await this.autoUpdater.dispose();
        // Drain operations accepted before dispose.
        await this.exclusive(async () => undefined);
    }
    async refreshOne(name, trigger) {
        const startedAt = this.now();
        const record = await this.registry.refresh(name);
        const code = record.lastErrorCode;
        if (code) {
            this.observe('refresh', { result: 'error', trigger, code }, startedAt);
            this.options.logger.warn('plugin marketplace refresh failed', {
                marketplace: name,
                trigger,
                code,
            });
            return record;
        }
        await this.refreshRemoteHeads(record);
        this.observe('refresh', { result: 'ok', trigger }, startedAt);
        return record;
    }
    /** Latest commits of installed Git-sourced entries; only refresh touches the network. */
    async refreshRemoteHeads(record) {
        if (record.source.kind !== 'git')
            return;
        const market = await this.loadMarket(record);
        const records = await this.installs.read(await this.installedOrEmpty());
        const pending = [...records.values()].flatMap((install) => {
            const entry = install.id.marketplace === record.name && market.catalog
                ? findCatalogEntry(market.catalog, install.id.name)
                : undefined;
            return entry?.source.kind === 'git' && !entry.source.sha
                ? [{ install, source: entry.source }]
                : [];
        });
        if (pending.length === 0)
            return;
        for (const { install, source } of pending) {
            const head = await this.remoteHeadOrUndefined(record.name, source);
            if (head)
                records.set(pluginIdKey(install.id), { ...install, remoteHead: head });
        }
        await this.installs.write(records.values());
    }
    async remoteHeadOrUndefined(marketplace, source) {
        try {
            return await resolveHead(source.remote, source.ref, { timeoutMs: REMOTE_HEAD_TIMEOUT_MS });
        }
        catch (error) {
            this.options.logger.warn('plugin marketplace entry head check failed', {
                marketplace,
                host: source.remote.displayHost(),
                code: errorCodeOf(error),
            });
            return undefined;
        }
    }
    async installEntry(id) {
        const { market, resolved } = await this.requireEntry(id);
        const entryId = { name: resolved.entry.name, marketplace: market.record.name };
        const installed = await this.options.installer.listInstalled();
        if (installed.some((plugin) => samePluginId(plugin.id, entryId))) {
            throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin is already installed');
        }
        const state = resolved.state;
        if (market.record.source.kind === 'directory' && state && !state.assembled) {
            if (resolved.unavailableReason)
                throw entryUnavailable(resolved.unavailableReason);
            // Folder marketplaces load relative entries in place: no copy, no writes.
            const input = await this.materializer.linkInput(resolved.entry, state);
            return this.options.installer.link({ id: entryId, ...input });
        }
        return this.installOwned(market, resolved, entryId, false);
    }
    async installOwned(market, resolved, id, replacing) {
        const material = await this.materialize(market, resolved);
        try {
            const plugin = await this.options.installer.acceptOwned(material.prepared, replacing ? { id, replacing: true } : { id });
            await this.recordInstall(plugin, material);
            return plugin;
        }
        finally {
            await material.prepared.discard();
        }
    }
    async materialize(market, resolved) {
        const { entry } = resolved;
        if (resolved.unavailableReason)
            throw entryUnavailable(resolved.unavailableReason);
        if (entry.source.kind === 'git') {
            const { prepared, commitSha } = await this.materializer.fromGit(entry, entry.source);
            return { prepared, version: entry.version ?? commitSha, remoteHead: commitSha };
        }
        if (!resolved.state || !market.root)
            throw entryUnavailable('SOURCE_MISSING');
        const prepared = await this.materializer.fromCatalogRoot(entry, resolved.state);
        return { prepared, ...(resolved.version ? { version: resolved.version } : {}) };
    }
    // Best effort: the Plugin is installed either way; without a record it only
    // loses update and local-change detection.
    async recordInstall(plugin, material) {
        try {
            const record = {
                id: plugin.id,
                rootPath: plugin.rootPath,
                installedDigest: plugin.contentDigest,
                files: await digestFiles(plugin.rootPath),
                ...(material.version ? { version: material.version } : {}),
                ...(material.remoteHead ? { remoteHead: material.remoteHead } : {}),
            };
            await this.installs.put(record, await this.installedOrEmpty());
        }
        catch (error) {
            this.options.logger.warn('plugin marketplace install record failed', {
                marketplace: plugin.id.marketplace,
                code: errorCodeOf(error),
            });
        }
    }
    async updateTarget(id) {
        const installed = await this.options.installer.listInstalled();
        const current = installed.find((plugin) => samePluginId(plugin.id, id));
        if (!current)
            throw new PluginSystemError('PLUGIN_NOT_FOUND', 'Plugin is not installed');
        const record = await this.registry.find(current.id.marketplace);
        if (!record)
            throw notFound();
        if (record.source.kind === 'directory' || current.ownership === 'linked') {
            throw marketplaceError(MarketplaceErrorCode.UPDATE_UNSUPPORTED, 'Folder marketplaces load in place and are not upgraded');
        }
        const previous = (await this.installs.read(installed)).get(pluginIdKey(current.id));
        return { current, previous, edited: hasLocalChanges(current, previous) };
    }
    async replaceInstalled(target) {
        const { current, previous, edited } = target;
        const discardedLocalChanges = previous && edited ? await changedSince(previous, current.rootPath) : [];
        const { market, resolved } = await this.requireEntry(current.id);
        const plugin = await this.installOwned(market, resolved, current.id, true);
        return { plugin, discardedLocalChanges };
    }
    async requireEntry(id) {
        const record = await this.registry.find(id.marketplace);
        if (!record)
            throw notFound();
        const market = await this.loadMarket(record);
        if (!market.catalog) {
            throw marketplaceError(MarketplaceErrorCode.MANIFEST_NOT_FOUND, 'Marketplace catalog is unreadable');
        }
        const entry = findCatalogEntry(market.catalog, id.name);
        if (!entry)
            throw new PluginSystemError('PLUGIN_NOT_FOUND', 'Plugin is not listed in the marketplace');
        return { market, resolved: await this.resolveEntry(market, entry) };
    }
    async describeGroup(market, plugins, installRecords) {
        const catalog = market?.catalog;
        const listed = catalog
            ? plugins.flatMap((plugin) => findCatalogEntry(catalog, plugin.id.name) ?? [])
            : [];
        const resolved = market ? await this.resolveEntries(market, listed) : [];
        const byName = new Map(resolved.map((item) => [entryNameKey(item.entry.name), item]));
        const states = await Promise.all(plugins.map(async (plugin) => {
            const key = pluginIdKey(plugin.id);
            const item = byName.get(entryNameKey(plugin.id.name));
            return [
                key,
                await describeInstalledPlugin(market, plugin, item, installRecords.get(key)),
            ];
        }));
        return new Map(states);
    }
    async resolveEntries(market, entries) {
        const states = await Promise.all(entries.map((entry) => this.inspect(market, entry)));
        const objects = await snapshotObjects(market, entries, states);
        return entries.map((entry, index) => resolveEntry(market, entry, states[index], objects));
    }
    async resolveEntry(market, entry) {
        const state = await this.inspect(market, entry);
        return resolveEntry(market, entry, state, await snapshotObjects(market, [entry], [state]));
    }
    async inspect(market, entry) {
        if (entry.source.kind !== 'relative' || !market.root)
            return undefined;
        return inspectRelativeEntry(market.root, entry, entry.source);
    }
    async entryView(market, resolved) {
        const { entry, state } = resolved;
        const preview = state && !resolved.unavailableReason
            ? await this.materializer.preview(entry, state)
            : undefined;
        return {
            id: { name: entry.name, marketplace: market.record.name },
            ...displayFields(resolved, preview),
            dependencies: resolved.dependencies,
            ...(resolved.unavailableReason ? { unavailableReason: resolved.unavailableReason } : {}),
            ...(preview ? { preview } : {}),
        };
    }
    async loadMarket(record) {
        const root = this.registry.rootOf(record);
        if (!root)
            return { record, errorCode: MarketplaceErrorCode.MANIFEST_NOT_FOUND };
        try {
            return { record, root, catalog: (await readCatalog(root)).catalog };
        }
        catch (error) {
            return { record, root, errorCode: errorCodeOf(error) };
        }
    }
    async view(record, installed) {
        const market = await this.loadMarket(record);
        const lastErrorCode = record.lastErrorCode ?? market.errorCode;
        return {
            name: record.name,
            ...definedStrings({
                displayName: market.catalog?.displayName,
                description: market.catalog?.description,
                lastErrorCode,
            }),
            source: record.source,
            autoUpdate: record.source.kind === 'git' && record.autoUpdate,
            pluginCount: market.catalog?.entries.length ?? 0,
            installedPlugins: installed
                .filter((plugin) => plugin.id.marketplace === record.name)
                .map((plugin) => plugin.id),
            ...(record.lastSyncedAtMs === undefined ? {} : { lastSyncedAtMs: record.lastSyncedAtMs }),
        };
    }
    async autoSyncCandidates() {
        if (this.idle())
            return [];
        return (await this.registry.list())
            .filter((record) => record.source.kind === 'git' && record.autoUpdate)
            .map((record) => ({
            name: record.name,
            ...(record.lastSyncedAtMs === undefined ? {} : { lastSyncedAtMs: record.lastSyncedAtMs }),
        }));
    }
    /** Refreshes one marketplace, then updates its Plugins that have no local edits. */
    async autoSync(name) {
        if (this.idle())
            return;
        const record = await this.exclusive(async () => (await this.registry.find(name)) ? this.refreshOne(name, 'auto') : undefined);
        if (!record || record.lastErrorCode)
            return;
        const owned = (await this.options.installer.listInstalled()).filter((plugin) => plugin.id.marketplace === name && plugin.ownership === 'owned');
        const states = await this.describeInstalled(owned);
        for (const plugin of owned) {
            if (this.idle())
                return;
            if (states.get(pluginIdKey(plugin.id))?.updateAvailable)
                await this.autoUpdate(plugin.id);
        }
    }
    async autoUpdate(id) {
        const startedAt = this.now();
        try {
            const outcome = await this.exclusive(async () => {
                const target = await this.updateTarget(id);
                // The automatic path never overwrites edits, nor a copy it cannot compare.
                if (target.edited || !target.previous)
                    return 'skipped';
                await this.replaceInstalled(target);
                return 'ok';
            });
            this.observe('update', { result: outcome, trigger: 'auto' }, startedAt);
            this.options.logger.info('plugin marketplace auto update', {
                marketplace: id.marketplace,
                result: outcome,
            });
        }
        catch (error) {
            const code = errorCodeOf(error);
            this.observe('update', { result: 'error', trigger: 'auto', code }, startedAt);
            this.options.logger.warn('plugin marketplace auto update failed', {
                marketplace: id.marketplace,
                code,
            });
        }
    }
    reportBackgroundFailure(error) {
        const code = errorCodeOf(error);
        this.options.metrics.incr('plugin_marketplace_auto_sync_failure_total', { code });
        this.options.logger.warn('plugin marketplace auto sync failed', { code });
    }
    async uninstallFailure(id) {
        try {
            await this.options.installer.uninstall(id);
            return undefined;
        }
        catch (error) {
            const code = errorCodeOf(error, MarketplaceErrorCode.UNINSTALL_FAILED);
            this.options.logger.warn('plugin marketplace uninstall failed', {
                marketplace: id.marketplace,
                code,
            });
            return code;
        }
    }
    async installedOrEmpty() {
        try {
            return await this.options.installer.listInstalled();
        }
        catch (error) {
            this.options.logger.warn('plugin marketplace could not list installed plugins', {
                code: errorCodeOf(error),
            });
            return [];
        }
    }
    observe(operation, tags, startedAt) {
        this.options.metrics.incr(`plugin_marketplace_${operation}_total`, tags);
        this.options.metrics.latency(`plugin_marketplace_${operation}_duration_ms`, this.now() - startedAt, tags);
    }
    assertUsable() {
        if (this.disposed)
            throw new PluginSystemError('DISPOSED', 'Plugin marketplaces are disposed');
        this.assertEnabled();
    }
    assertEnabled() {
        if (!this.options.isEnabled()) {
            throw marketplaceError(MarketplaceErrorCode.DISABLED, 'Plugin marketplaces are not available in this build');
        }
    }
    /** Background sync does nothing after dispose or while the release gate is off. */
    idle() {
        return this.disposed || !this.options.isEnabled();
    }
}
async function describeInstalledPlugin(market, plugin, resolved, install) {
    const owned = plugin.ownership === 'owned';
    const installedManifest = owned ? await probeManifest(plugin.rootPath) : undefined;
    const dependencies = unique([
        ...(resolved?.dependencies ?? []),
        ...manifestDependencies(installedManifest),
    ]);
    const localChanges = owned && hasLocalChanges(plugin, install);
    if (!market?.catalog || !resolved) {
        return {
            updateAvailable: false,
            hasLocalChanges: localChanges,
            unavailableReason: 'NOT_IN_MARKETPLACE',
            dependencies,
        };
    }
    return {
        updateAvailable: isUpdateAvailable(market, plugin, resolved, install),
        hasLocalChanges: localChanges,
        dependencies,
    };
}
function isUpdateAvailable(market, plugin, resolved, install) {
    // Folder marketplaces never upgrade; a copy without a record cannot be compared.
    if (market.record.source.kind !== 'git' || plugin.ownership !== 'owned' || !install)
        return false;
    if (resolved.unavailableReason)
        return false;
    const latest = resolved.entry.source.kind === 'git'
        ? (resolved.version ?? install.remoteHead)
        : resolved.version;
    return latest !== undefined && install.version !== undefined && latest !== install.version;
}
function hasLocalChanges(plugin, install) {
    return (install !== undefined &&
        plugin.contentDigest !== '' &&
        install.installedDigest !== plugin.contentDigest);
}
async function changedSince(install, rootPath) {
    try {
        return changedFiles(install.files, await digestFiles(rootPath));
    }
    catch {
        return [];
    }
}
function resolveEntry(market, entry, state, objects) {
    const missingRoot = entry.source.kind === 'relative' && !state ? 'SOURCE_MISSING' : undefined;
    const unavailableReason = entry.unavailableReason ?? state?.unavailableReason ?? missingRoot;
    const version = entryVersion(market, entry, state, objects);
    return {
        entry,
        ...(state ? { state } : {}),
        ...(version ? { version } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        dependencies: unique([...entry.dependencies, ...manifestDependencies(state?.manifest)]),
    };
}
/**
 * plugin.json version, then the entry version, then a content identity:
 * the entry directory's tree hash in a Git marketplace (only changes when that
 * directory changes) or the pinned commit of a Git-sourced entry.
 */
function entryVersion(market, entry, state, objects) {
    if (entry.source.kind === 'git')
        return entry.version ?? entry.source.sha;
    const declared = manifestVersion(state?.manifest) ?? entry.version;
    if (declared || market.record.source.kind !== 'git' || !state?.location)
        return declared;
    if (!state.assembled)
        return objects.get(state.location.relativePath);
    const parts = declaredComponentPaths(entry).map((item) => `${item}:${objects.get(item) ?? ''}`);
    return createHash('sha256').update(parts.join('\n')).digest('hex');
}
/** Git object ids of every path that identifies an entry version, in one git call. */
async function snapshotObjects(market, entries, states) {
    if (market.record.source.kind !== 'git' || !market.root)
        return new Map();
    const paths = entries.flatMap((entry, index) => {
        const state = states[index];
        if (!state?.location)
            return [];
        return state.assembled ? declaredComponentPaths(entry) : [state.location.relativePath];
    });
    if (paths.length === 0)
        return new Map();
    try {
        return await pathObjectShas(market.root, paths);
    }
    catch {
        return new Map();
    }
}
/** Codex entries carry little display data; the Plugin manifest fills the gaps. */
function displayFields(resolved, preview) {
    const { entry } = resolved;
    return {
        ...definedStrings({
            displayName: entry.displayName ?? preview?.displayName,
            description: entry.description ?? preview?.description,
            author: entry.author ?? preview?.author,
            version: resolved.version ?? preview?.version,
            homepage: entry.homepage,
        }),
        category: entry.category === 'Other' ? (preview?.category ?? 'Other') : entry.category,
    };
}
function filterEntries(entries, query) {
    const keyword = query.keyword?.trim().toLocaleLowerCase('en-US');
    return entries.filter((entry) => (!query.category || entry.category === query.category) &&
        (!keyword ||
            [entry.name, entry.displayName, entry.description].some((text) => text?.toLocaleLowerCase('en-US').includes(keyword))));
}
function cursorOffset(cursor) {
    const offset = Number.parseInt(cursor ?? '', 10);
    return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}
function pageSize(limit) {
    if (limit === undefined || !Number.isInteger(limit) || limit <= 0)
        return DEFAULT_PAGE_SIZE;
    return Math.min(limit, MAX_PAGE_SIZE);
}
function groupByMarketplace(plugins) {
    const groups = new Map();
    for (const plugin of plugins) {
        groups.set(plugin.id.marketplace, [...(groups.get(plugin.id.marketplace) ?? []), plugin]);
    }
    return groups;
}
function hostField(source) {
    // Logs carry the host only, never a repository path or a local folder.
    return source.kind === 'git' ? { host: source.remote.displayHost() } : {};
}
function definedStrings(fields) {
    return Object.fromEntries(Object.entries(fields).filter((pair) => pair[1] !== undefined));
}
function unique(values) {
    return [...new Set(values)];
}
function entryUnavailable(reason) {
    return marketplaceError(MarketplaceErrorCode.ENTRY_UNAVAILABLE, 'Entry cannot be installed', reason);
}
function notFound() {
    return marketplaceError(MarketplaceErrorCode.NOT_FOUND, 'Marketplace is not added');
}
/** Runs operations one at a time in submission order; a failure does not block the next. */
function createSerialQueue() {
    let tail = Promise.resolve();
    return async (operation) => {
        const previous = tail;
        let release = () => undefined;
        tail = new Promise((resolve) => {
            release = resolve;
        });
        try {
            await previous;
            return await operation();
        }
        finally {
            release();
        }
    };
}
//# sourceMappingURL=marketplace-service.js.map