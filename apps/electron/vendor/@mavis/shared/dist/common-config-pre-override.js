/**
 * Pre-release overrides for public common_config keys.
 *
 * Production and staging clients read the same Apollo namespace through the same
 * public endpoint. Every staging-build reader (Desktop renderer, Electron main,
 * local runtime and Web SSR) also requests `pre_<key>` for every filtered key. When Apollo has that key, its value
 * replaces `<key>` as a whole; without it the staging build keeps the production
 * value. Production builds never request or read `pre_` keys.
 *
 * Releasing to everyone means publishing the value under `<key>` and deleting
 * `pre_<key>` in Apollo; no client change is needed.
 */
export const PRE_COMMON_CONFIG_KEY_PREFIX = 'pre_';
/** Adds the `pre_` counterpart of every filtered key after the base keys. */
export function withPreCommonConfigKeys(filter) {
    const keys = filter.split(',').filter(Boolean);
    const requested = new Set(keys);
    for (const key of keys) {
        if (!key.startsWith(PRE_COMMON_CONFIG_KEY_PREFIX)) {
            requested.add(`${PRE_COMMON_CONFIG_KEY_PREFIX}${key}`);
        }
    }
    return [...requested].join(',');
}
/** Replaces each base key with its `pre_` value when present and drops every `pre_` key. */
export function applyPreCommonConfigOverrides(document) {
    const entries = Object.entries(document);
    const result = {};
    for (const [key, value] of entries) {
        if (!key.startsWith(PRE_COMMON_CONFIG_KEY_PREFIX))
            result[key] = value;
    }
    for (const [key, value] of entries) {
        const baseKey = key.slice(PRE_COMMON_CONFIG_KEY_PREFIX.length);
        if (key.startsWith(PRE_COMMON_CONFIG_KEY_PREFIX) && baseKey)
            result[baseKey] = value;
    }
    return result;
}
//# sourceMappingURL=common-config-pre-override.js.map