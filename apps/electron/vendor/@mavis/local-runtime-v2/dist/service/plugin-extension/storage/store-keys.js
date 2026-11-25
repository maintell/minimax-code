import { isMiniMaxPluginName } from '../../plugin-system/index.js';
import { ExtensionServiceError } from '../errors.js';
const STORE_KEY = /^[A-Za-z0-9._-]{1,128}$/u;
/** Session ids and install commit ids share one safe path-segment shape. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** two.md §3: `^[A-Za-z0-9._-]{1,128}$`, and never `.` / `..`. */
export function assertStoreKey(key) {
    if (typeof key !== 'string' || !STORE_KEY.test(key) || key === '.' || key === '..') {
        throw new ExtensionServiceError('STORE_KEY_INVALID', 'store key must match ^[A-Za-z0-9._-]{1,128}$ and must not be "." or ".."');
    }
}
export function assertPathSegments(pluginId, sessionId) {
    if (!isMiniMaxPluginName(pluginId) || (sessionId !== undefined && !SESSION_ID.test(sessionId))) {
        throw new ExtensionServiceError('STORE_KEY_INVALID', 'store namespace is not a safe path');
    }
}
/**
 * Keys become lowercase base32 file names: case-insensitive file systems cannot merge `A` and
 * `a`, and no key can spell a reserved device name such as `con`.
 */
export function keyToFileStem(key) {
    let bits = 0;
    let value = 0;
    let out = 'k';
    for (const byte of Buffer.from(key, 'utf8')) {
        value = ((value << 8) | byte) & 0xffff;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += BASE32[(value << (5 - bits)) & 31];
    return out;
}
export function fileStemToKey(stem) {
    if (!stem.startsWith('k'))
        return undefined;
    const bytes = [];
    let bits = 0;
    let value = 0;
    for (const char of stem.slice(1)) {
        const index = BASE32.indexOf(char);
        if (index < 0)
            return undefined;
        value = ((value << 5) | index) & 0xffff;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    const key = Buffer.from(bytes).toString('utf8');
    return STORE_KEY.test(key) && keyToFileStem(key) === stem ? key : undefined;
}
//# sourceMappingURL=store-keys.js.map