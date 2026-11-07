import { isValidPluginMarketplaceName, LOCAL_PLUGIN_MARKETPLACE, OFFICIAL_PLUGIN_MARKETPLACE, } from '@mavis/shared';
/**
 * Git sources allowed to use brand-protected marketplace names. Extend this
 * list instead of adding special cases elsewhere; folders are never exempt.
 */
const BRAND_EXEMPT_GIT_SOURCES = [{ host: 'gitlab.xaminim.com' }, { host: 'github.com', owner: 'minimax-ai' }];
// Built-in marketplaces, plus object members: names are used as object keys.
const RESERVED_NAMES = new Set([
    OFFICIAL_PLUGIN_MARKETPLACE,
    LOCAL_PLUGIN_MARKETPLACE,
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
]);
const BRAND_NAMES = new Set([
    'minimax',
    'mcode',
    'minimax-code',
    'minimax-plugins',
    'minimax-marketplace',
]);
const BRAND_WORDS = new Set(['minimax', 'mcode']);
// C0/C1 controls and Unicode bidirectional formatting characters.
const UNSAFE_CHARACTER = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/**
 * Policy for the name a catalog declares. Taken names are checked by the
 * registry, which owns the set of added marketplaces.
 */
export function checkMarketplaceName(name, gitSource) {
    if (RESERVED_NAMES.has(name))
        return 'RESERVED';
    if (UNSAFE_CHARACTER.test(name) || !isValidPluginMarketplaceName(name))
        return 'INVALID';
    if (isBrandProtected(name) && !isBrandExempt(gitSource))
        return 'RESERVED';
    return undefined;
}
/**
 * `minimax`, `mcode`, their product names, and any name pairing a brand word
 * with `official` (`minimax-official`, `official.mcode`). Ordinary names that
 * merely contain a brand word (`my-minimax-skills`) stay available.
 */
function isBrandProtected(name) {
    const normalized = name.toLowerCase().replace(/[._-]+/gu, '-');
    if (BRAND_NAMES.has(normalized))
        return true;
    const words = normalized.split('-');
    return words.includes('official') && words.some((word) => BRAND_WORDS.has(word));
}
function isBrandExempt(gitSource) {
    if (!gitSource)
        return false;
    return BRAND_EXEMPT_GIT_SOURCES.some((exempt) => gitSource.host === exempt.host &&
        (exempt.owner === undefined || gitSource.owner() === exempt.owner));
}
//# sourceMappingURL=marketplace-name.js.map