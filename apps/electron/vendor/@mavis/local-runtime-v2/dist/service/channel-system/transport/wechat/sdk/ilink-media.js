/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-media.ts`.
 */
/**
 * iLink Bot SDK — Media handling module.
 *
 * AES-128-ECB encryption/decryption for CDN upload/download.
 * Provides a high-level upload pipeline and download+decrypt utility.
 */
import { settleOr } from '../../../settle.js';
import crypto, { createCipheriv, createDecipheriv } from 'node:crypto';
import { ilinkFetch } from './ilink-fetch.js';
import { UploadMediaType } from './ilink-types.js';
// ---------------------------------------------------------------------------
// AES-128-ECB primitives
// ---------------------------------------------------------------------------
/** Encrypt buffer with AES-128-ECB (PKCS7 padding). */
export function encryptAesEcb(plaintext, key) {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize) {
    return Math.ceil((plaintextSize + 1) / 16) * 16;
}
// ---------------------------------------------------------------------------
// AES key parsing (for inbound media)
// ---------------------------------------------------------------------------
/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings seen in the wild:
 *   - base64(raw 16 bytes)           → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 */
export function parseAesKey(aesKeyBase64) {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) {
        return decoded;
    }
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
        return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`);
}
// ---------------------------------------------------------------------------
// CDN URL construction
// ---------------------------------------------------------------------------
// CDN base URL for downloading media (different from API base URL)
const CDN_DOWNLOAD_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(encryptedQueryParam, _cdnBaseUrl) {
    // Format: {cdn_base_url}/download?encrypted_query_param={url_encoded_param}
    return `${CDN_DOWNLOAD_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
/** Build a CDN upload URL from upload_param and filekey. */
export function buildCdnUploadUrl(params) {
    return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
// ---------------------------------------------------------------------------
// CDN Download + Decrypt
// ---------------------------------------------------------------------------
/**
 * Generate X-WECHAT-UIN header value (base64 of random uint32 as string)
 */
function generateWechatUin() {
    const randomUint32 = crypto.randomInt(0, 0xffffffff);
    return Buffer.from(String(randomUint32)).toString('base64');
}
/**
 * Download and AES-128-ECB decrypt a CDN media file.
 * @param aesKeyBase64 CDNMedia.aes_key (see parseAesKey for supported formats)
 * @param token Auth token for CDN requests
 */
export async function downloadAndDecrypt(encryptedQueryParam, aesKeyBase64, cdnBaseUrl, token) {
    const key = parseAesKey(aesKeyBase64);
    const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    const headers = {
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': generateWechatUin(),
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await ilinkFetch(url, { headers });
    if (!res.ok) {
        const body = await settleOr(res.text(), '(unreadable)');
        throw new Error(`CDN download failed: ${res.status} ${res.statusText} body=${body}`);
    }
    const encrypted = Buffer.from(await res.arrayBuffer());
    return decryptAesEcb(encrypted, key);
}
/** Download plain (unencrypted) bytes from CDN. */
export async function downloadPlain(encryptedQueryParam, cdnBaseUrl, token) {
    const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    const headers = {
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': generateWechatUin(),
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await ilinkFetch(url, { headers });
    if (!res.ok) {
        const body = await settleOr(res.text(), '(unreadable)');
        throw new Error(`CDN download failed: ${res.status} ${res.statusText} body=${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
}
// ---------------------------------------------------------------------------
// CDN Upload (with encryption)
// ---------------------------------------------------------------------------
const UPLOAD_MAX_RETRIES = 3;
/**
 * Upload a buffer to the CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 */
async function uploadBufferToCdn(params) {
    const { buf, uploadParam, uploadFullUrl, filekey, cdnBaseUrl, aeskey } = params;
    const ciphertext = encryptAesEcb(buf, aeskey);
    const cdnUrl = uploadFullUrl || buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
    let downloadParam;
    let lastError;
    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
        try {
            downloadParam = await uploadCiphertextOnce(cdnUrl, ciphertext);
            break;
        }
        catch (err) {
            lastError = err;
            // 4xx is a caller bug (bad params) — retrying cannot help.
            if (err instanceof Error && err.message.includes('client error'))
                throw err;
            if (attempt >= UPLOAD_MAX_RETRIES)
                break;
        }
    }
    if (!downloadParam) {
        throw lastError instanceof Error
            ? lastError
            : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
    }
    return { downloadParam };
}
/** One CDN POST; returns the x-encrypted-param download handle. */
async function uploadCiphertextOnce(cdnUrl, ciphertext) {
    const res = await ilinkFetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
    });
    if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
    }
    if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
    }
    const downloadParam = res.headers.get('x-encrypted-param');
    if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
    }
    return downloadParam;
}
/**
 * High-level upload pipeline:
 *   1. Generate filekey + AES key
 *   2. Compute sizes/MD5
 *   3. Call getUploadUrl API
 *   4. Upload encrypted buffer to CDN
 *   5. Return UploadedFileInfo
 */
export async function uploadMedia(params) {
    const { client, buf, toUserId, cdnBaseUrl, mediaType } = params;
    const rawsize = buf.length;
    const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);
    const uploadUrlResp = await client.getUploadUrl({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
    });
    if (uploadUrlResp.ret !== undefined && uploadUrlResp.ret !== 0) {
        throw new Error(`getUploadUrl failed: ret=${uploadUrlResp.ret}`);
    }
    if (uploadUrlResp.errcode !== undefined && uploadUrlResp.errcode !== 0) {
        throw new Error(`getUploadUrl failed: errcode=${uploadUrlResp.errcode}`);
    }
    const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
    const uploadParam = uploadUrlResp.upload_param;
    if (!uploadFullUrl && !uploadParam) {
        throw new Error('getUploadUrl returned no upload_full_url or upload_param');
    }
    const { downloadParam } = await uploadBufferToCdn({
        buf,
        uploadParam: uploadParam ?? '',
        uploadFullUrl,
        filekey,
        cdnBaseUrl,
        aeskey,
    });
    return {
        filekey,
        downloadEncryptedQueryParam: downloadParam,
        aeskey: aeskey.toString('hex'),
        fileSize: rawsize,
        fileSizeCiphertext: filesize,
    };
}
/** Convenience: upload an image buffer. */
export async function uploadImage(params) {
    return uploadMedia({ ...params, mediaType: UploadMediaType.IMAGE });
}
/** Convenience: upload a video buffer. */
export async function uploadVideo(params) {
    return uploadMedia({ ...params, mediaType: UploadMediaType.VIDEO });
}
/** Convenience: upload a file buffer. */
export async function uploadFile(params) {
    return uploadMedia({ ...params, mediaType: UploadMediaType.FILE });
}
//# sourceMappingURL=ilink-media.js.map