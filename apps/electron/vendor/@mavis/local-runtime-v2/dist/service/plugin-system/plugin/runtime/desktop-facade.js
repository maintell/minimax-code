import { formatPluginId, isBuiltInPluginMarketplace, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, pluginIdKey, } from '@mavis/shared';
import { InstalledPluginSource, MarketplaceCategory, PluginInstallationPolicy, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { withConnectorCatalog } from '../../app/plugin-apps.js';
import { findInstalledLocalPlugin, findLocalPlugin } from '../../plugin-system-helpers.js';
import { installedLocalPlugin } from '../local/local-plugin-lifecycle.js';
import { PluginRegistryClient } from './registry-client.js';
import { effectiveInstallationPolicy } from './repository.js';
import { builtInMarketplaces, catalogEntryDetail, catalogEntrySummary, installedIdentityFields, installedSummaryFields, marketplaceInfo, nameHolder, nameOwnerField, } from './wire/marketplace-views.js';
import { categoryId, categoryName, declaredTransport, optionalPluginIcon, pluginPackageSummary, } from './wire/package-views.js';
import { PluginDesktopFacadeError, readUserMarketplaceName, resolveCatalogTarget, resolvePluginTarget, userMarketplaceOf, } from './wire/plugin-selector.js';
export { PluginDesktopFacadeError } from './wire/plugin-selector.js';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const NO_MARKETPLACE_STATES = new Map();
/**
 * Desktop projection over the Cloud registry, user-added marketplaces, and the
 * accepted local snapshot. Requests address Plugins as `<name>@<marketplace>`;
 * a request without a marketplace keeps the legacy `source` semantics.
 */
export class PluginDesktopFacade {
    options;
    constructor(options) {
        this.options = options;
    }
    refresh() {
        return this.options.system.refresh();
    }
    setLocalPluginEnabled(name, enabled) {
        return this.options.system.setLocalPluginEnabled({ name }, enabled);
    }
    uninstallLocalPlugin(name) {
        return this.options.system.uninstallLocalPlugin({ name });
    }
    async listMarketplacePlugins(req) {
        const target = resolveCatalogTarget(req);
        if (target.kind === 'official') {
            return this.projectStandaloneSkillAdded(await this.overlayOfficialMarketplaceState(await this.options.registryClient.listMarketplace(req)));
        }
        if (target.kind === 'user')
            return this.listUserMarketplace(target.marketplace, req);
        const skillLimit = pageLimit(req.skillLimit ?? req.limit);
        const [standaloneSkills, localSnapshot] = await Promise.all([
            this.options.listStandaloneSkills({
                keyword: req.keyword,
                limit: skillLimit,
                cursor: req.skillCursor,
            }),
            this.options.system.refreshLocalPluginsForMarketplace({
                // The watcher invalidates this projection for real filesystem changes.
                // Search/filter/pagination must not repeatedly hash every local package.
                reuseCached: true,
            }),
        ]);
        const local = localMarketplacePage(localSnapshot, req, await this.describeInstalled(localSnapshot));
        return {
            plugins: local.plugins,
            nextCursor: local.nextCursor,
            hasMore: local.hasMore,
            pluginTotal: local.pluginTotal,
            marketplaceSkills: standaloneSkills.skills.map(localStandaloneSkillSummary),
            skillNextCursor: standaloneSkills.nextCursor,
            skillHasMore: standaloneSkills.hasMore,
        };
    }
    async getMarketplacePlugin(req) {
        const target = resolvePluginTarget(req);
        if (target.lifecycle === 'official') {
            const response = await this.options.registryClient.getMarketplace(req);
            if (!response.plugin)
                return response;
            const installations = await this.options.system.listOfficialPluginInstallations();
            return {
                ...response,
                plugin: {
                    ...response.plugin,
                    summary: overlayOfficialSummary(response.plugin.summary, installations, this.options.system.currentSnapshot),
                },
            };
        }
        const localSnapshot = await this.options.system.refreshLocalPluginsForMarketplace({
            reuseCached: true,
        });
        const marketplace = userMarketplaceOf(target.selector);
        if (marketplace) {
            return this.getUserMarketplacePlugin(localSnapshot, {
                name: target.selector.name,
                marketplace,
            });
        }
        const local = findLocalPlugin(localSnapshot, target.selector);
        if (!local)
            throw new PluginDesktopFacadeError('PLUGIN_NOT_FOUND');
        const states = await this.describeInstalled(localSnapshot);
        const plugin = catalogEntryDetail(undefined, {
            id: local.id,
            installed: local,
            ...stateOf(states, local.id),
        });
        if (!plugin)
            throw new PluginDesktopFacadeError('PLUGIN_NOT_FOUND');
        return { plugin: await this.withConnectorApps(plugin) };
    }
    async listInstalledPlugins(req) {
        const filter = normalizedKeyword(req.keyword);
        const limit = pageLimit(req.limit);
        const cursor = decodeInstalledCursor(req.cursor, filter);
        const [officialStates, localSnapshot] = await Promise.all([
            this.options.system.listOfficialPluginStates(),
            this.options.system.refreshLocalPluginsForMarketplace({
                // Management polling reads the watcher-maintained projection. A full
                // hash scan is reserved for a cache miss or explicit refresh.
                reuseCached: true,
            }),
        ]);
        const official = officialInstalledItems(officialStates, filter, localSnapshot);
        const local = localInstalledItems(localSnapshot, filter, await this.describeInstalled(localSnapshot));
        return installedSnapshotPage([...official, ...local], filter, limit, cursor?.stage === 'snapshot' ? cursor.offset : 0);
    }
    async listEnabledPlugins(_req) {
        const names = new Set();
        const plugins = this.options.system.currentSnapshot.enabledPlugins.flatMap((plugin) => {
            const key = normalizedName(plugin.name);
            if (names.has(key))
                return [];
            names.add(key);
            return [
                {
                    name: plugin.name,
                    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
                    ...optionalPluginIcon(plugin),
                },
            ];
        });
        return { plugins };
    }
    async listEnabledPluginSkillSummaries() {
        const enabledPlugins = new Map(this.options.system.currentSnapshot.enabledPlugins.map((plugin) => [
            normalizedName(plugin.name),
            plugin,
        ]));
        const skills = this.options.system.currentSnapshot.turnCapabilities.skills.flatMap((skill) => {
            const plugin = enabledPlugins.get(normalizedName(skill.pluginName));
            if (!plugin)
                return [];
            const runtimeName = skill.name.trim();
            const pluginName = skill.pluginName.trim();
            const skillName = runtimeName.startsWith(`${pluginName}:`)
                ? runtimeName.slice(pluginName.length + 1)
                : runtimeName;
            if (!runtimeName || !pluginName || !skillName)
                return [];
            return [
                {
                    runtimeName,
                    pluginName,
                    skillName,
                    ...(plugin.displayName ? { pluginDisplayName: plugin.displayName } : {}),
                    ...optionalPluginSkillIcon(plugin),
                    description: skill.description,
                },
            ];
        });
        return skills;
    }
    installPlugin(req) {
        return this.mutate(req, 'install');
    }
    uninstallPlugin(req) {
        return this.mutate(req, 'uninstall');
    }
    enablePlugin(req) {
        return this.mutate(req, 'enable');
    }
    disablePlugin(req) {
        return this.mutate(req, 'disable');
    }
    /** Updates a Plugin installed from a user-added Git marketplace, overwriting local edits. */
    updatePlugin(req) {
        return this.mutate(req, 'update');
    }
    async listPluginMarketplaces(_req) {
        const views = this.options.marketplaces ? await this.options.marketplaces.list() : [];
        return { marketplaces: [...builtInMarketplaces(), ...views.map(marketplaceInfo)] };
    }
    async addPluginMarketplace(req) {
        const result = await this.requireMarketplaces().add({
            source: req.source,
            ...(req.ref?.trim() ? { ref: req.ref.trim() } : {}),
            ...(req.sparsePaths?.length ? { sparsePaths: [...req.sparsePaths] } : {}),
        });
        return { marketplace: marketplaceInfo(result.marketplace), alreadyAdded: result.alreadyAdded };
    }
    async refreshPluginMarketplaces(req) {
        const name = req.marketplaceName?.trim()
            ? readUserMarketplaceName(req.marketplaceName)
            : undefined;
        const views = await this.requireMarketplaces().refresh(name);
        return { marketplaces: views.map(marketplaceInfo) };
    }
    async setPluginMarketplaceAutoUpdate(req) {
        const view = await this.requireMarketplaces().setAutoUpdate(readUserMarketplaceName(req.marketplaceName), req.autoUpdate);
        return { marketplace: marketplaceInfo(view) };
    }
    async removePluginMarketplace(req) {
        const result = await this.requireMarketplaces().remove(readUserMarketplaceName(req.marketplaceName));
        return {
            removed: result.removed,
            uninstalledPlugins: result.uninstalled.map(formatPluginId),
            failedPlugins: result.failed.map((failure) => ({
                pluginId: formatPluginId(failure.id),
                errorCode: failure.code,
            })),
        };
    }
    async previewGithubPlugin(req, signal) {
        if (!this.options.githubImporter) {
            throw new PluginDesktopFacadeError('PLUGIN_IMPORT_UNAVAILABLE');
        }
        const startedAt = Date.now();
        let status = 'success';
        try {
            const preview = await this.options.githubImporter.preview(req.url, signal);
            return {
                source: preview.source,
                plugin: {
                    summary: {
                        ...pluginPackageSummary(preview.plugin, false, false),
                        marketplace: LOCAL_PLUGIN_MARKETPLACE,
                    },
                    skillCount: preview.plugin.skills.length,
                    mcpServerCount: preview.plugin.mcpServers.length,
                    hasStdioMcp: preview.plugin.mcpServers.some((server) => declaredTransport(server.configJson) === 'stdio'),
                },
                diagnostics: [...preview.plugin.diagnostics],
                packageSizeBytes: preview.packageSizeBytes,
                canImport: preview.canImport,
            };
        }
        catch (error) {
            status = signal?.aborted ? 'cancelled' : 'error';
            throw error;
        }
        finally {
            const tags = { status };
            this.options.metrics?.incr('plugin_github_preview_total', tags);
            this.options.metrics?.latency('plugin_github_preview_duration_ms', Date.now() - startedAt, tags);
        }
    }
    async importGithubPlugin(req) {
        const startedAt = Date.now();
        let status = 'success';
        try {
            const plugin = await this.options.system.importGithubPlugin(req.source);
            return {
                plugin: {
                    ...pluginPackageSummary(plugin, true, true),
                    marketplace: LOCAL_PLUGIN_MARKETPLACE,
                },
            };
        }
        catch (error) {
            status = 'error';
            throw error;
        }
        finally {
            const tags = { status };
            this.options.metrics?.incr('plugin_github_import_total', tags);
            this.options.metrics?.latency('plugin_github_import_duration_ms', Date.now() - startedAt, tags);
        }
    }
    async mutate(req, action) {
        const target = resolvePluginTarget(req);
        const sourceLabel = target.lifecycle;
        const startedAt = Date.now();
        let status = 'success';
        try {
            if (target.lifecycle === 'official') {
                // Official packages update through the Registry, never on request.
                if (action === 'update')
                    throw new PluginDesktopFacadeError('PLUGIN_UPDATE_UNSUPPORTED');
                return await this.mutateOfficial(req, action);
            }
            return await this.mutateLocal(target.selector, action);
        }
        catch (error) {
            status = 'error';
            throw error;
        }
        finally {
            const tags = { source: sourceLabel, action, status };
            this.options.metrics?.incr('plugin_mutation_total', tags);
            this.options.metrics?.latency('plugin_mutation_duration_ms', Date.now() - startedAt, tags);
        }
    }
    async mutateOfficial(req, action) {
        const authOutcome = await this.options.waitForOfficialAuth();
        if (authOutcome === 'logged_out') {
            throw new PluginDesktopFacadeError('PLUGIN_AUTH_REQUIRED');
        }
        if (authOutcome !== 'ready') {
            throw new PluginDesktopFacadeError('PLUGIN_AUTH_SYNC_TIMEOUT');
        }
        const scope = this.options.system.captureOfficialScope();
        if (!scope)
            throw new PluginDesktopFacadeError('PLUGIN_AUTH_REQUIRED');
        const requestedName = req.pluginName.trim();
        try {
            // Persist explicit withdrawal before dispatch: a committed response can be lost.
            if (action === 'disable' || action === 'uninstall') {
                await this.options.system.revokeOfficialSelection(requestedName, scope, action === 'uninstall' ? 'uninstalled' : 'disabled');
            }
            const response = await this.options.registryClient.mutate(requestedName, action);
            assertOfficialMutationResponse(response, requestedName);
            await this.options.system.applyOfficialMutation({
                pluginName: requestedName,
                installExists: response.installExists,
                enabled: response.enabled,
                installationPolicy: response.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED,
                ...(response.package ? { package: response.package } : {}),
            }, scope);
            this.forgetMiniAppPermissions(action, response.installExists, requestedName, 'official');
            return response;
        }
        catch (error) {
            // Once the request is in flight, the registry may already have committed
            // even when validation, transport, download, or local publication fails.
            // Recover from the authoritative full state without delaying this error.
            this.options.system.requestOfficialRecovery(scope);
            throw error;
        }
    }
    /** A confirmed uninstall drops the Mini App switches; a reinstall starts fully enabled. */
    forgetMiniAppPermissions(action, installExists, pluginName, source) {
        if (action !== 'uninstall' || installExists)
            return;
        this.options.system.miniAppPublication.forgetPermissions(pluginName, source);
    }
    async mutateLocal(selector, action) {
        const marketplace = userMarketplaceOf(selector);
        if (action === 'install') {
            // LOCAL packages arrive through files, Git import, or a user-added marketplace.
            if (!marketplace)
                throw new PluginDesktopFacadeError('LOCAL_PLUGIN_INSTALL_UNSUPPORTED');
            const installed = await this.requireMarketplaces().install({
                name: selector.name,
                marketplace,
            });
            return {
                source: InstalledPluginSource.LOCAL,
                installExists: true,
                enabled: installed.enabled,
            };
        }
        if (action === 'update')
            return this.updateLocal(selector);
        const result = action === 'uninstall'
            ? await this.options.system.uninstallLocalPlugin(selector)
            : await this.options.system.setLocalPluginEnabled(selector, action === 'enable');
        this.forgetMiniAppPermissions(action, result.installExists, selector.name, 'local');
        return {
            source: InstalledPluginSource.LOCAL,
            installExists: result.installExists,
            enabled: result.enabled,
        };
    }
    /** Only Plugins installed from a user-added marketplace can update on request. */
    async updateLocal(selector) {
        let id;
        const marketplace = userMarketplaceOf(selector);
        if (marketplace) {
            id = { name: selector.name, marketplace };
        }
        else {
            const snapshot = await this.options.system.refreshLocalPluginsForMarketplace({
                reuseCached: true,
            });
            const installed = findLocalPlugin(snapshot, selector);
            if (!installed)
                throw new PluginDesktopFacadeError('PLUGIN_NOT_FOUND');
            id = installed.id;
        }
        if (isBuiltInPluginMarketplace(id.marketplace)) {
            throw new PluginDesktopFacadeError('PLUGIN_UPDATE_UNSUPPORTED');
        }
        const result = await this.requireMarketplaces().update(id);
        return {
            source: InstalledPluginSource.LOCAL,
            installExists: true,
            enabled: result.plugin.enabled,
            discardedLocalChanges: [...result.discardedLocalChanges],
        };
    }
    async listUserMarketplace(marketplace, req) {
        const service = this.requireMarketplaces();
        const category = categoryName(req.category);
        const limit = pageLimit(req.limit);
        if (req.category !== undefined && !category) {
            return { plugins: [], hasMore: false, pluginTotal: 0, marketplaceSkills: [] };
        }
        const keyword = req.keyword?.trim();
        const [page, localSnapshot] = await Promise.all([
            service.listEntries(marketplace, {
                ...(keyword ? { keyword } : {}),
                ...(category ? { category } : {}),
                ...(req.cursor ? { cursor: req.cursor } : {}),
                limit,
            }),
            this.options.system.refreshLocalPluginsForMarketplace({ reuseCached: true }),
        ]);
        const states = await this.describeInstalled(localSnapshot);
        return {
            plugins: page.entries.map((entry) => {
                const installed = findInstalledLocalPlugin(localSnapshot, entry.id);
                return catalogEntrySummary(entry, {
                    ...(installed ? { installed } : {}),
                    ...stateOf(states, entry.id),
                    ...holderOf(localSnapshot, entry.preview?.name ?? entry.id.name),
                });
            }),
            hasMore: page.hasMore,
            pluginTotal: page.total,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            marketplaceSkills: [],
            skillHasMore: false,
        };
    }
    async getUserMarketplacePlugin(localSnapshot, id) {
        const installed = findInstalledLocalPlugin(localSnapshot, id);
        const states = installed ? await this.describeInstalled(localSnapshot) : NO_MARKETPLACE_STATES;
        const entry = installed ? undefined : await this.requireMarketplaces().getEntry(id);
        const plugin = catalogEntryDetail(entry, {
            id,
            ...(installed ? { installed } : {}),
            ...stateOf(states, id),
            ...holderOf(localSnapshot, entry?.preview?.name ?? id.name),
        });
        if (!plugin)
            throw new PluginDesktopFacadeError('PLUGIN_NOT_FOUND');
        return { plugin: await this.withConnectorApps(plugin) };
    }
    /**
     * Local detail must work offline and signed out: the Connector catalog only decorates declared
     * providers, and any Cloud failure keeps the bare declaration.
     */
    async withConnectorApps(detail) {
        const catalog = this.options.connectorCatalog;
        if (!catalog || detail.apps.length === 0)
            return detail;
        try {
            return { ...detail, apps: withConnectorCatalog(detail.apps, await catalog.listConnectors()) };
        }
        catch {
            return detail;
        }
    }
    /** Marketplace facts are hints: listing never fails because they are unavailable. */
    async describeInstalled(snapshot) {
        const service = this.options.marketplaces;
        const plugins = snapshot.localPlugins.filter((plugin) => !isBuiltInPluginMarketplace(plugin.id.marketplace));
        if (!service || plugins.length === 0)
            return NO_MARKETPLACE_STATES;
        try {
            return await service.describeInstalled(plugins.map(installedLocalPlugin));
        }
        catch {
            return NO_MARKETPLACE_STATES;
        }
    }
    requireMarketplaces() {
        if (!this.options.marketplaces) {
            throw new PluginDesktopFacadeError('PLUGIN_MARKETPLACE_UNAVAILABLE');
        }
        return this.options.marketplaces;
    }
    async overlayOfficialMarketplaceState(response) {
        const installations = await this.options.system.listOfficialPluginInstallations();
        const snapshot = this.options.system.currentSnapshot;
        return {
            ...response,
            plugins: response.plugins.map((plugin) => overlayOfficialSummary(plugin, installations, snapshot)),
        };
    }
    async projectStandaloneSkillAdded(response) {
        if (!response.marketplaceSkills)
            return response;
        const installed = await this.options.standaloneSkillIdentities();
        return {
            ...response,
            marketplaceSkills: response.marketplaceSkills.map((item) => ({
                ...item,
                added: isStandaloneSkillAdded(item, installed),
            })),
        };
    }
}
function assertOfficialMutationResponse(response, requestedName) {
    if (response.source !== InstalledPluginSource.OFFICIAL) {
        throw new PluginDesktopFacadeError('PLUGIN_MUTATION_SOURCE_INVALID');
    }
    if (response.package && normalizedName(response.package.name) !== normalizedName(requestedName)) {
        throw new PluginDesktopFacadeError('PLUGIN_MUTATION_PACKAGE_INVALID');
    }
}
function localStandaloneSkillSummary(skill) {
    return {
        id: stableLocalSkillId(skill),
        name: skill.name,
        ...(skill.displayName ? { displayName: skill.displayName } : {}),
        ...(skill.description ? { description: skill.description } : {}),
        ...(skill.displayDescription ? { displayDescription: skill.displayDescription } : {}),
        ...(skill.sourceType !== undefined ? { sourceType: skill.sourceType } : {}),
        ...(skill.creatorInfo ? { creatorInfo: skill.creatorInfo } : {}),
        ...(skill.createdAt !== undefined ? { createdAt: skill.createdAt } : {}),
        ...(skill.updatedAt !== undefined ? { updatedAt: skill.updatedAt } : {}),
        added: true,
    };
}
/** Stable page identity for local Skills that do not own a Marketplace database id. */
function stableLocalSkillId(skill) {
    const identity = [skill.locationUri, skill.sourceKind, skill.agentName, skill.name]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\u0000');
    let high = 0xdeadbeef;
    let low = 0x41c6ce57;
    for (let index = 0; index < identity.length; index += 1) {
        const code = identity.charCodeAt(index);
        high = Math.imul(high ^ code, 2_654_435_761);
        low = Math.imul(low ^ code, 1_597_334_677);
    }
    high =
        Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
    low =
        Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
    const value = 4_294_967_296 * (low & 0x1fffff) + (high >>> 0);
    return -(value || 1);
}
function localMarketplacePage(snapshot, req, states) {
    const filter = normalizedKeyword(req.keyword);
    const category = req.category;
    const categoryKey = category ?? -1;
    const cursor = decodeLocalCursor(req.cursor, filter, categoryKey);
    const limit = pageLimit(req.limit);
    const items = snapshot.localPlugins
        .filter((plugin) => localPluginMatchesKeyword(plugin, filter))
        .filter((plugin) => category === undefined || category === categoryId(plugin.plugin.category))
        .map((plugin) => localMarketplaceSummary(plugin, states.get(pluginIdKey(plugin.id))));
    const offset = cursor?.offset ?? 0;
    const plugins = items.slice(offset, offset + limit);
    const nextOffset = offset + plugins.length;
    const hasMore = nextOffset < items.length;
    return {
        plugins,
        hasMore,
        pluginTotal: items.length,
        ...(hasMore
            ? {
                nextCursor: encodeCursor({
                    version: 1,
                    kind: 'marketplace-local',
                    filter,
                    category: categoryKey,
                    offset: nextOffset,
                }),
            }
            : {}),
    };
}
function installedSnapshotPage(items, filter, limit, offset) {
    const plugins = items.slice(offset, offset + limit);
    const nextOffset = offset + plugins.length;
    const hasMore = nextOffset < items.length;
    return {
        plugins,
        hasMore,
        ...(hasMore
            ? {
                nextCursor: encodeCursor({
                    version: 1,
                    kind: 'installed',
                    filter,
                    stage: 'snapshot',
                    offset: nextOffset,
                }),
            }
            : {}),
    };
}
function officialInstalledItems(states, filter, snapshot) {
    return states.flatMap((state) => officialInstalledItem(state, filter, snapshot));
}
function officialInstalledItem({ installation, plugin }, filter, snapshot) {
    if (!pluginMatchesKeyword(installation.name, plugin?.displayName, filter))
        return [];
    return [toOfficialInstalledSummary(installation, plugin, snapshot)];
}
function toOfficialInstalledSummary(installation, plugin, snapshot) {
    return {
        name: installation.name,
        ...officialInstalledMetadata(installation, plugin),
        capabilities: officialInstalledCapabilities(plugin),
        source: InstalledPluginSource.OFFICIAL,
        enabled: installation.enabled,
        installationPolicy: effectiveInstallationPolicy(installation),
        category: plugin ? categoryId(plugin.category) : MarketplaceCategory.OTHER,
        ...officialIdentityFields(installation.name, snapshot),
    };
}
function officialInstalledMetadata(installation, plugin) {
    const current = installation.package;
    return {
        ...(current?.version ? { version: current.version } : {}),
        ...(plugin?.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin?.description ? { description: plugin.description } : {}),
        ...(plugin?.author ? { author: plugin.author } : {}),
        ...(plugin ? optionalPluginIcon(plugin) : {}),
    };
}
function officialInstalledCapabilities(plugin) {
    return {
        appCount: plugin?.apps.length ?? 0,
        mcpServerCount: plugin?.mcpServers.length ?? 0,
        skillCount: plugin?.skills.length ?? 0,
        hookCount: plugin?.hooks?.length ?? 0,
        agentCount: plugin?.agents?.length ?? 0,
    };
}
function overlayOfficialSummary(summary, installations, snapshot) {
    const installation = installations.find((item) => normalizedName(item.name) === normalizedName(summary.name));
    return {
        ...summary,
        installExists: installation?.installed ?? false,
        enabled: installation?.enabled ?? false,
        installationPolicy: installation
            ? effectiveInstallationPolicy(installation)
            : (summary.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED),
        ...officialIdentityFields(summary.name, snapshot),
    };
}
/** An official Plugin always wins its name when enabled; otherwise it names the holder. */
function officialIdentityFields(name, snapshot) {
    return {
        marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
        ...nameOwnerField({ name, marketplace: OFFICIAL_PLUGIN_MARKETPLACE }, nameHolder(snapshot, name)),
    };
}
function localInstalledItems(snapshot, filter, states) {
    return snapshot.localPlugins.flatMap((plugin) => {
        if (!localPluginMatchesKeyword(plugin, filter))
            return [];
        const state = states.get(pluginIdKey(plugin.id));
        const summary = localMarketplaceSummary(plugin, state);
        return [
            {
                name: summary.name,
                ...(summary.version ? { version: summary.version } : {}),
                ...(summary.displayName ? { displayName: summary.displayName } : {}),
                ...(summary.description ? { description: summary.description } : {}),
                ...(summary.author ? { author: summary.author } : {}),
                ...(summary.iconUrl ? { iconUrl: summary.iconUrl } : {}),
                ...(summary.darkIconUrl ? { darkIconUrl: summary.darkIconUrl } : {}),
                capabilities: summary.capabilities,
                source: InstalledPluginSource.LOCAL,
                enabled: summary.enabled,
                installationPolicy: PluginInstallationPolicy.USER_MANAGED,
                category: summary.category,
                ...installedIdentityFields(plugin, state),
            },
        ];
    });
}
/** Every installed PluginId is listed, including copies whose name another Plugin holds. */
function localMarketplaceSummary(plugin, state) {
    return {
        name: plugin.id.name,
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.author ? { author: plugin.author } : {}),
        ...optionalPluginIcon(plugin),
        capabilities: {
            appCount: plugin.plugin.apps.length,
            mcpServerCount: plugin.plugin.mcpServers.length,
            skillCount: plugin.plugin.skills.length,
            hookCount: plugin.plugin.hooks?.length ?? 0,
            agentCount: plugin.plugin.agents?.length ?? 0,
        },
        installExists: true,
        enabled: plugin.enabled,
        installationPolicy: PluginInstallationPolicy.USER_MANAGED,
        category: categoryId(plugin.plugin.category),
        ...installedSummaryFields(plugin, state),
    };
}
function stateOf(states, id) {
    const state = states.get(pluginIdKey(id));
    return state ? { state } : {};
}
function holderOf(snapshot, manifestName) {
    const holder = nameHolder(snapshot, manifestName);
    return holder ? { holder } : {};
}
function localPluginMatchesKeyword(plugin, keyword) {
    return (pluginMatchesKeyword(plugin.id.name, plugin.displayName, keyword) ||
        normalizedName(plugin.name).includes(keyword));
}
function optionalPluginSkillIcon(plugin) {
    const icon = optionalPluginIcon(plugin);
    return {
        ...(icon.iconUrl ? { pluginIconUrl: icon.iconUrl } : {}),
        ...(icon.darkIconUrl ? { pluginDarkIconUrl: icon.darkIconUrl } : {}),
    };
}
function isStandaloneSkillAdded(item, installed) {
    const sourceUrl = item.sourceUrl?.trim();
    if (sourceUrl && installed.sourceUrls.has(sourceUrl))
        return true;
    return installed.names.has(normalizedName(item.name));
}
function decodeInstalledCursor(value, filter) {
    if (!value)
        return undefined;
    const parsed = decodeCursor(value);
    if (parsed.version !== 1 || parsed.kind !== 'installed' || parsed.filter !== filter) {
        throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
    }
    return readInstalledStage(parsed, filter);
}
function readInstalledStage(parsed, filter) {
    if (parsed.stage === 'snapshot' && isOffset(parsed.offset)) {
        return { version: 1, kind: 'installed', filter, stage: 'snapshot', offset: parsed.offset };
    }
    throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
}
function decodeLocalCursor(value, filter, category) {
    if (!value)
        return undefined;
    const parsed = decodeCursor(value);
    if (parsed.version !== 1 ||
        parsed.kind !== 'marketplace-local' ||
        parsed.filter !== filter ||
        parsed.category !== category ||
        !isOffset(parsed.offset)) {
        throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
    }
    return { version: 1, kind: 'marketplace-local', filter, category, offset: parsed.offset };
}
function encodeCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeCursor(value) {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Mapped to the stable cursor error below.
    }
    throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
}
function pageLimit(value) {
    if (value === undefined)
        return DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value <= 0) {
        throw new PluginDesktopFacadeError('PLUGIN_LIMIT_INVALID');
    }
    return Math.min(value, MAX_LIMIT);
}
function isOffset(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function normalizedKeyword(value) {
    return normalizedName(value ?? '');
}
function pluginMatchesKeyword(name, displayName, keyword) {
    return (normalizedName(name).includes(keyword) ||
        (displayName !== undefined && normalizedName(displayName).includes(keyword)));
}
function normalizedName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=desktop-facade.js.map