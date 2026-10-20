/**
 * 热更新 manifest 校验（纯函数，不依赖 Electron）
 *
 * 签名内容是去掉 `signature` 字段后、按 key 排序的 JSON（canonical JSON），
 * 与发布脚本 `scripts/mmx-agent/hot-update/manifest.mjs` 保持一致。
 */

import * as crypto from "crypto";
export let HOT_UPDATE_MANIFEST_SCHEMA_VERSION = 2;
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = canonicalize(value[key]);
        }
        return sorted;
    }
    return value;
}
/** 生成被签名的 payload */
export function canonicalManifestPayload(manifest) {
    const { signature: _signature, ...unsigned } = manifest;
    return JSON.stringify(canonicalize(unsigned));
}
export function verifyManifestSignature(manifest, publicKeys) {
    const signature = manifest.signature;
    if (typeof signature !== 'string' || signature.length === 0)
        return false;
    const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8');
    const signatureBytes = Buffer.from(signature, 'base64');
    for (const key of publicKeys) {
        try {
            const publicKey = crypto.createPublicKey({
                key: Buffer.from(key, 'base64'),
                format: 'der',
                type: 'spki',
            });
            if (crypto.verify(null, payload, publicKey, signatureBytes))
                return true;
        }
        catch {
            // 无效公钥或签名格式：继续尝试下一把公钥
        }
    }
    return false;
}
/** 解析 `{appVersion}-renderer.{n}` */
export function parseRendererVersion(version) {
    const match = /^(\d+\.\d+\.\d+)-renderer\.(\d+)$/.exec(version);
    if (!match)
        return null;
    return { appVersion: match[1], rendererNum: Number.parseInt(match[2], 10) };
}
/**
 * 比较同一 appVersion 下的热更新版本号；null 表示打包版本，任何热更新版本都大于 null。
 */
export function compareRendererVersions(v1, v2) {
    if (v1 === v2)
        return 0;
    if (v1 === null)
        return -1;
    if (v2 === null)
        return 1;
    const p1 = parseRendererVersion(v1);
    const p2 = parseRendererVersion(v2);
    if (!p1 || !p2)
        return v1.localeCompare(v2);
    if (p1.appVersion !== p2.appVersion)
        return p1.appVersion.localeCompare(p2.appVersion);
    return Math.sign(p1.rendererNum - p2.rendererNum);
}
function isString(value) {
    return typeof value === 'string' && value.length > 0;
}
/**
 * 校验 manifest：先验签，再校验字段与当前壳是否匹配。
 * rollback manifest 只要求通道、语言、appVersion 匹配，不要求壳指纹一致。
 */
export function validateManifest(raw, expected) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, reason: 'invalid_json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid_shape' };
    }
    const record = parsed;
    if (record.schemaVersion !== HOT_UPDATE_MANIFEST_SCHEMA_VERSION) {
        return { ok: false, reason: 'unsupported_schema' };
    }
    if (!isString(record.signature))
        return { ok: false, reason: 'missing_signature' };
    if (!verifyManifestSignature(record, expected.publicKeys)) {
        return { ok: false, reason: 'bad_signature' };
    }
    if (!isString(record.channel) ||
        !isString(record.locale) ||
        !isString(record.appVersion) ||
        !isString(record.version)) {
        return { ok: false, reason: 'invalid_shape' };
    }
    if (record.channel !== expected.channel)
        return { ok: false, reason: 'channel_mismatch' };
    if (record.locale !== expected.locale)
        return { ok: false, reason: 'locale_mismatch' };
    if (record.appVersion !== expected.baseAppVersion) {
        return { ok: false, reason: 'app_version_mismatch' };
    }
    const parsedVersion = parseRendererVersion(record.version);
    if (!parsedVersion || parsedVersion.appVersion !== record.appVersion) {
        return { ok: false, reason: 'invalid_version' };
    }
    const rollback = record.rollback === true;
    if (!rollback) {
        if (!isString(record.url) ||
            !isString(record.sha256) ||
            !/^[0-9a-f]{64}$/.test(record.sha256) ||
            typeof record.size !== 'number' ||
            !Number.isSafeInteger(record.size) ||
            record.size <= 0 ||
            !isString(record.shellFingerprint)) {
            return { ok: false, reason: 'invalid_shape' };
        }
        if (!record.url.startsWith('https://'))
            return { ok: false, reason: 'invalid_url' };
        if (record.shellFingerprint !== expected.shellFingerprint) {
            return { ok: false, reason: 'shell_mismatch' };
        }
    }
    return { ok: true, manifest: { ...record, rollback } };
}
