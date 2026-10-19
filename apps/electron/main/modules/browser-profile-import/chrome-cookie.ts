import { createHash, timingSafeEqual, pbkdf2Sync, createDecipheriv } from "node:crypto";
const CHROME_EPOCH_OFFSET_SECONDS = 11644473600n;
const MICROSECONDS_PER_SECOND = 1000000n;
const MAX_COOKIE_NAME_BYTES = 4 * 1024;
const MAX_COOKIE_VALUE_BYTES = 64 * 1024;
export function chromeTimeToUnixSeconds(chromeMicroseconds) {
    return Number(chromeMicroseconds / MICROSECONDS_PER_SECOND - CHROME_EPOCH_OFFSET_SECONDS);
}
export function domainMatchesHost(cookieDomain, currentHost) {
    const domain = cookieDomain.trim().toLowerCase().replace(/^\./, '');
    const host = currentHost.trim().toLowerCase().replace(/\.$/, '');
    return Boolean(domain && host && (host === domain || host.endsWith(`.${domain}`)));
}
function sameSite(value) {
    if (value === 0n)
        return 'no_restriction';
    if (value === 1n)
        return 'lax';
    if (value === 2n)
        return 'strict';
    return 'unspecified';
}
function stripHostDigest(plaintext, hostKey, databaseVersion) {
    if (databaseVersion < 24)
        return plaintext;
    if (plaintext.length < 32)
        throw new Error('Chrome cookie host digest is missing');
    const expected = createHash('sha256').update(hostKey).digest();
    const actual = plaintext.subarray(0, 32);
    if (!timingSafeEqual(expected, actual)) {
        throw new Error('Chrome cookie host digest mismatch');
    }
    return plaintext.subarray(32);
}
export function normalizeChromeCookie(row, options = {}) {
    const domain = row.host_key.trim().toLowerCase();
    const hostname = domain.replace(/^\./, '');
    const cookiePath = row.path.startsWith('/') ? row.path : '/';
    const nameBytes = Buffer.byteLength(row.name);
    const valueBytes = Buffer.byteLength(row.value);
    if (!hostname ||
        !row.name ||
        nameBytes > MAX_COOKIE_NAME_BYTES ||
        valueBytes > MAX_COOKIE_VALUE_BYTES) {
        return null;
    }
    const secure = row.is_secure !== 0n;
    const normalized = {
        url: `${secure ? 'https' : 'http'}://${hostname}${cookiePath}`,
        name: row.name,
        value: row.value,
        ...(domain.startsWith('.') ? { domain } : {}),
        path: cookiePath,
        secure,
        httpOnly: row.is_httponly !== 0n,
        sameSite: sameSite(row.samesite),
    };
    if (row.expires_utc !== 0n) {
        const expirationDate = chromeTimeToUnixSeconds(row.expires_utc);
        const nowUnixSeconds = options.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
        if (!Number.isFinite(expirationDate) || expirationDate <= nowUnixSeconds)
            return null;
        normalized.expirationDate = expirationDate;
    }
    return normalized;
}
export function decryptMacChromeCookie(options) {
    const { encryptedValue, hostKey, safeStoragePassword, databaseVersion } = options;
    const prefix = encryptedValue.subarray(0, 3).toString('ascii');
    if (prefix !== 'v10' && prefix !== 'v11') {
        throw new Error('Unsupported macOS Chrome cookie encryption version');
    }
    const key = pbkdf2Sync(safeStoragePassword, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
    return stripHostDigest(plaintext, hostKey, databaseVersion).toString('utf8');
}
export async function decryptWindowsChromeCookie(options) {
    const { encryptedValue, masterKey, hostKey, databaseVersion, dpapiUnprotect } = options;
    const prefix = encryptedValue.subarray(0, 3).toString('ascii');
    if (prefix === 'v20')
        return { value: null, unsupported: true };
    if (prefix === 'v10' || prefix === 'v11') {
        if (!masterKey || masterKey.length !== 32) {
            throw new Error('Chrome AES-GCM master key is unavailable');
        }
        if (encryptedValue.length < 3 + 12 + 16)
            throw new Error('Invalid Chrome AES-GCM cookie');
        const nonce = encryptedValue.subarray(3, 15);
        const ciphertextAndTag = encryptedValue.subarray(15);
        const ciphertext = ciphertextAndTag.subarray(0, -16);
        const authTag = ciphertextAndTag.subarray(-16);
        const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return {
            value: stripHostDigest(plaintext, hostKey, databaseVersion).toString('utf8'),
            unsupported: false,
        };
    }
    const plaintext = await dpapiUnprotect(encryptedValue);
    return {
        value: stripHostDigest(plaintext, hostKey, databaseVersion).toString('utf8'),
        unsupported: false,
    };
}
