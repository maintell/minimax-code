/**
 * Plugin identity across marketplaces.
 *
 * A PluginId addresses one listed or installed Plugin as `<name>@<marketplace>`.
 * `official` and `local` are the built-in marketplaces; every other value names a
 * user-added marketplace. Install, enable, uninstall, and update address Plugins by
 * PluginId, while names exposed to the model (Skill prefixes, MCP and App names)
 * keep using the Plugin's manifest name. At most one Plugin per manifest name is
 * effective at a time.
 */
export const OFFICIAL_PLUGIN_MARKETPLACE = 'official';
export const LOCAL_PLUGIN_MARKETPLACE = 'local';
const MARKETPLACE_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
export function formatPluginId(id) {
    return `${id.name}@${id.marketplace}`;
}
/**
 * Splits `<name>@<marketplace>` at the last `@`. A value without a non-empty name
 * and marketplace on both sides of that `@` is a bare name.
 */
export function parsePluginSelector(value) {
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1)
        return { name: trimmed };
    return { name: trimmed.slice(0, at), marketplace: trimmed.slice(at + 1) };
}
/** Equality key: Plugin names compare like installed names do (trimmed, NFKC, case-insensitive). */
export function pluginIdKey(id) {
    return `${id.name.trim().normalize('NFKC').toLocaleLowerCase('en-US')}@${id.marketplace}`;
}
export function samePluginId(left, right) {
    return pluginIdKey(left) === pluginIdKey(right);
}
export function isBuiltInPluginMarketplace(marketplace) {
    return marketplace === OFFICIAL_PLUGIN_MARKETPLACE || marketplace === LOCAL_PLUGIN_MARKETPLACE;
}
/**
 * Marketplace name syntax: lowercase ASCII letters, digits, `.`, `_`, and `-`,
 * starting and ending with a letter or digit, at most 64 characters. Reserved and
 * brand-protected names are a separate policy owned by the Desktop runtime.
 */
export function isValidPluginMarketplaceName(value) {
    return MARKETPLACE_NAME.test(value);
}
//# sourceMappingURL=plugin-id.js.map