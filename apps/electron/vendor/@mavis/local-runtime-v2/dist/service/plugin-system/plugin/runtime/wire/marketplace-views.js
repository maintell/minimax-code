import { formatPluginId, isBuiltInPluginMarketplace, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, pluginIdKey, } from '@mavis/shared';
import { PluginMarketplaceSourceKind, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { categoryId, pluginPackageDetail, pluginPackageSummary } from './package-views.js';
/** official and local come first: not removable, not user-upgradable, no catalog count. */
export function builtInMarketplaces() {
    return [
        {
            name: OFFICIAL_PLUGIN_MARKETPLACE,
            source: { kind: PluginMarketplaceSourceKind.OFFICIAL },
            builtIn: true,
            autoUpdate: false,
            installedPlugins: [],
        },
        {
            name: LOCAL_PLUGIN_MARKETPLACE,
            source: { kind: PluginMarketplaceSourceKind.LOCAL },
            builtIn: true,
            autoUpdate: false,
            installedPlugins: [],
        },
    ];
}
export function marketplaceInfo(view) {
    const { source } = view;
    return {
        name: view.name,
        ...(view.displayName ? { displayName: view.displayName } : {}),
        ...(view.description ? { description: view.description } : {}),
        source: source.kind === 'git'
            ? {
                kind: PluginMarketplaceSourceKind.GIT,
                url: source.url,
                ...(source.ref ? { ref: source.ref } : {}),
                ...(source.sparsePaths?.length ? { sparsePaths: [...source.sparsePaths] } : {}),
            }
            : { kind: PluginMarketplaceSourceKind.DIRECTORY, path: source.path },
        builtIn: false,
        autoUpdate: view.autoUpdate,
        pluginCount: view.pluginCount,
        installedPlugins: view.installedPlugins.map(formatPluginId),
        ...(view.lastSyncedAtMs !== undefined ? { lastSyncedAtMs: view.lastSyncedAtMs } : {}),
        ...(view.lastErrorCode ? { lastErrorCode: view.lastErrorCode } : {}),
    };
}
/** The effective Plugin holding a manifest name, from the published roster. */
export function nameHolder(snapshot, manifestName) {
    const key = nameKey(manifestName);
    return snapshot.enabledPlugins.find((plugin) => nameKey(plugin.name) === key)?.id;
}
/** `name_owner` only when another Plugin holds the name. */
export function nameOwnerField(id, owner) {
    return owner && pluginIdKey(owner) !== pluginIdKey(id)
        ? { nameOwner: formatPluginId(owner) }
        : {};
}
/**
 * Identity and lifecycle hints of an installed LOCAL Plugin. User-added
 * marketplace Plugins always report update and local-change state.
 */
export function installedIdentityFields(plugin, state) {
    const unavailableReason = plugin.unavailableReason ?? state?.unavailableReason;
    return {
        marketplace: plugin.id.marketplace,
        ...nameOwnerField(plugin.id, plugin.nameOwner),
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(isBuiltInPluginMarketplace(plugin.id.marketplace)
            ? {}
            : {
                updateAvailable: state?.updateAvailable ?? false,
                hasLocalChanges: state?.hasLocalChanges ?? false,
            }),
    };
}
/** Catalog card: catalog metadata with the installed copy's local state. */
export function catalogEntrySummary(entry, overlay) {
    const { installed, state } = overlay;
    const unavailableReason = installed?.unavailableReason ?? state?.unavailableReason ?? entry.unavailableReason;
    return {
        ...pluginPackageSummary(entry.preview ?? emptyPreview(entry), installed !== undefined, installed?.enabled ?? false),
        ...catalogMetadata(entry),
        ...(installed ? { updateAvailable: state?.updateAvailable ?? false } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        ...nameOwnerField(entry.id, installed ? installed.nameOwner : overlay.holder),
    };
}
/** Catalog fields win over the previewed manifest; the version is the resolved one. */
function catalogMetadata(entry) {
    return {
        name: entry.id.name,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.author ? { author: entry.author } : {}),
        category: categoryId(entry.category),
        marketplace: entry.id.marketplace,
    };
}
/** Detail of a user-added marketplace Plugin: the installed copy when present. */
export function catalogEntryDetail(entry, overlay) {
    const { installed, state } = overlay;
    if (installed) {
        const dependencies = state?.dependencies ?? entry?.dependencies;
        const detail = pluginPackageDetail(installed.plugin, true, installed.enabled);
        return {
            ...detail,
            summary: {
                ...detail.summary,
                name: overlay.id.name,
                ...installedSummaryFields(installed, state),
            },
            ...(dependencies ? { dependencies: [...dependencies] } : {}),
        };
    }
    if (!entry)
        return undefined;
    const summary = catalogEntrySummary(entry, overlay);
    const detail = entry.preview
        ? pluginPackageDetail(entry.preview, false, false)
        : { apps: [], mcpServers: [], skills: [], exampleQueries: [] };
    return { ...detail, summary, dependencies: [...entry.dependencies] };
}
/** Summary fields of an installed LOCAL Plugin; `has_local_changes` is installed-list only. */
export function installedSummaryFields(installed, state) {
    const fields = installedIdentityFields(installed, state);
    return {
        marketplace: fields.marketplace,
        ...(fields.nameOwner ? { nameOwner: fields.nameOwner } : {}),
        ...(fields.unavailableReason ? { unavailableReason: fields.unavailableReason } : {}),
        ...(fields.updateAvailable === undefined ? {} : { updateAvailable: fields.updateAvailable }),
    };
}
/** Git entries are not readable before install; the card uses catalog metadata only. */
function emptyPreview(entry) {
    return {
        source: 'LOCAL_\u0043\u004c\u0041\u0055\u0044\u0045',
        manifestKind: '\u0043\u004c\u0041\u0055\u0044\u0045_CODE',
        rootPath: '',
        manifestPath: '',
        name: entry.id.name,
        category: entry.category,
        exampleQueries: [],
        apps: [],
        mcpServers: [],
        skills: [],
        diagnostics: [],
    };
}
function nameKey(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=marketplace-views.js.map