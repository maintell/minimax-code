import { isBuiltInPluginMarketplace, isValidPluginMarketplaceName, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, } from '@mavis/shared';
import { InstalledPluginSource } from '@mavis/thrift-gen/generated/desktop-service/types';
export class PluginDesktopFacadeError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'PluginDesktopFacadeError';
    }
}
/** Missing source keeps the legacy OFFICIAL default. */
function readSource(value) {
    if (value === undefined || value === InstalledPluginSource.OFFICIAL || value === '1') {
        return InstalledPluginSource.OFFICIAL;
    }
    if (value === InstalledPluginSource.LOCAL || value === '2')
        return InstalledPluginSource.LOCAL;
    throw new PluginDesktopFacadeError('INVALID_PLUGIN_SOURCE');
}
/**
 * `marketplace` names a user-added marketplace only; the built-in catalogs
 * stay addressed by `source`. User-added Plugins have the LOCAL lifecycle, so
 * only an OFFICIAL source contradicts a marketplace.
 */
export function resolveCatalogTarget(req) {
    const marketplace = readMarketplace(req.marketplace);
    if (marketplace === undefined) {
        return readSource(req.source) === InstalledPluginSource.OFFICIAL
            ? { kind: 'official' }
            : { kind: 'local' };
    }
    if (isBuiltInPluginMarketplace(marketplace)) {
        throw new PluginDesktopFacadeError('PLUGIN_MARKETPLACE_INVALID');
    }
    assertLocalLifecycle(req.source);
    return { kind: 'user', marketplace };
}
/**
 * `plugin_name` plus `marketplace` form the PluginId. Without a marketplace,
 * `source` keeps its legacy meaning and a LOCAL name is resolved later, failing
 * as ambiguous when several installed Plugins share it.
 */
export function resolvePluginTarget(req) {
    const name = req.pluginName.trim();
    const marketplace = readMarketplace(req.marketplace);
    if (marketplace === undefined) {
        return readSource(req.source) === InstalledPluginSource.OFFICIAL
            ? { lifecycle: 'official', selector: { name } }
            : { lifecycle: 'local', selector: { name } };
    }
    if (marketplace === OFFICIAL_PLUGIN_MARKETPLACE) {
        if (req.source !== undefined && readSource(req.source) !== InstalledPluginSource.OFFICIAL) {
            throw new PluginDesktopFacadeError('PLUGIN_SOURCE_CONFLICT');
        }
        return { lifecycle: 'official', selector: { name, marketplace } };
    }
    assertLocalLifecycle(req.source);
    return { lifecycle: 'local', selector: { name, marketplace } };
}
/** A user-added marketplace name, or undefined for `local` and bare names. */
export function userMarketplaceOf(selector) {
    const { marketplace } = selector;
    return marketplace === undefined || marketplace === LOCAL_PLUGIN_MARKETPLACE
        ? undefined
        : marketplace;
}
/** Management routes accept user-added marketplaces only. */
export function readUserMarketplaceName(value) {
    const name = readMarketplace(value);
    if (name === undefined)
        throw new PluginDesktopFacadeError('PLUGIN_MARKETPLACE_INVALID');
    if (isBuiltInPluginMarketplace(name)) {
        throw new PluginDesktopFacadeError('PLUGIN_MARKETPLACE_BUILT_IN');
    }
    return name;
}
/** An empty value is treated as absent. */
function readMarketplace(value) {
    const marketplace = value?.trim();
    if (!marketplace)
        return undefined;
    if (!isBuiltInPluginMarketplace(marketplace) && !isValidPluginMarketplaceName(marketplace)) {
        throw new PluginDesktopFacadeError('PLUGIN_MARKETPLACE_INVALID');
    }
    return marketplace;
}
function assertLocalLifecycle(source) {
    if (source !== undefined && readSource(source) !== InstalledPluginSource.LOCAL) {
        throw new PluginDesktopFacadeError('PLUGIN_SOURCE_CONFLICT');
    }
}
//# sourceMappingURL=plugin-selector.js.map