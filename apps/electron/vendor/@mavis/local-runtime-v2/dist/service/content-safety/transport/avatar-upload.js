import { Buffer } from 'node:buffer';
import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import { managedBackendRoutingHeaders } from '@mavis/agent-tools/desktop';
import { isSafetyCheckV2Record, SafetyCheckV2Error } from '@mavis/shared/safety-check-v2';
import { resolveSafetyApiBase } from './api-base.js';
const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_HOSTS = new Set([
    'matrix-internal-cn.oss-cn-shanghai.aliyuncs.com',
    'matrix-internal.oss-us-east-1.aliyuncs.com',
]);
/** 私有 CONTENT_SAFETY 对象仅用于审核；Agent 持久化仍使用原始本地头像。 */
export async function uploadAvatarForSafety(input) {
    const { bytes, mime } = decodeAvatar(input.content);
    const buildEnv = (input.buildEnv ?? getRuntimeBuildEnv)();
    const base = resolveSafetyApiBase((input.region ?? getRuntimeRegion)(), buildEnv, input.testBaseURL);
    const token = input.authContext?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
    const response = await input.fetchImpl(`${base}/minimax-cloud/api/v1/uploads/prepare?require_auth=true`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...managedBackendRoutingHeaders(input.routingContext, input.buildEnv ? buildEnv : process.env.MAVIS_BUILD_ENV),
        },
        body: JSON.stringify({
            purpose: 3,
            file_name: 'agent-avatar',
            mime_type: mime,
            size_bytes: bytes.length,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    validatePrepareResponse(response);
    const instruction = validateInstruction(await response.json(), mime, bytes.length);
    const form = new FormData();
    for (const [key, value] of Object.entries(instruction.fields))
        form.append(key, value);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'agent-avatar');
    const uploaded = await input.fetchImpl(instruction.url, {
        method: 'POST',
        body: form,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
    });
    if (uploaded.status !== 204)
        throw new SafetyCheckV2Error('http', uploaded.status);
    return { image_object_key: instruction.key, image_mime_type: mime };
}
function validatePrepareResponse(response) {
    if (response.status === 401 || response.status === 403)
        throw new SafetyCheckV2Error('auth', response.status);
    if (!response.ok)
        throw new SafetyCheckV2Error('http', response.status);
}
function decodeAvatar(content) {
    if (content.length > 4 * Math.ceil(MAX_BYTES / 3) + 64)
        throw new Error('Avatar exceeds size limit');
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(content);
    const mime = match?.[1];
    const base64 = match?.[2];
    if (!mime || !base64)
        throw new Error('Invalid avatar data URL');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== base64)
        throw new Error('Invalid avatar bytes');
    return { bytes, mime };
}
function validateInstruction(raw, mime, size) {
    if (!isSafetyCheckV2Record(raw))
        throw new Error('Invalid upload instruction');
    const payload = raw.object_key ? raw : raw.data;
    if (!isSafetyCheckV2Record(payload))
        throw new Error('Invalid upload envelope');
    const key = payload.object_key;
    const instruction = payload.upload_instruction;
    if (typeof key !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key))
        throw new Error('Invalid object key');
    if (!isSafetyCheckV2Record(instruction) ||
        instruction.method !== 'POST' ||
        typeof instruction.url !== 'string')
        throw new Error('Invalid upload instruction');
    const url = validateUploadURL(instruction.url);
    const fields = validateFormFields(instruction.form_fields, { key, mime, size });
    return { key, url, fields };
}
function validateUploadURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        !UPLOAD_HOSTS.has(url.hostname))
        throw new Error('Untrusted upload URL');
    return url.toString();
}
function validateFormFields(raw, expected) {
    if (!isSafetyCheckV2Record(raw))
        throw new Error('Invalid upload fields');
    const fields = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || key === 'file')
            throw new Error('Invalid upload field');
        fields[key] = value;
    }
    const required = {
        key: expected.key,
        'Content-Type': expected.mime,
        'x-oss-object-acl': 'private',
        'x-oss-content-type': expected.mime,
        'x-oss-forbid-overwrite': 'true',
        success_action_status: '204',
        'x-oss-meta-mxa-size': String(expected.size),
        'x-oss-meta-mxa-purpose': 'CONTENT_SAFETY',
    };
    if (Object.entries(required).some(([key, value]) => fields[key] !== value) ||
        !fields.OSSAccessKeyId ||
        !fields.policy ||
        !fields.Signature)
        throw new Error('Invalid private upload policy');
    return fields;
}
//# sourceMappingURL=avatar-upload.js.map