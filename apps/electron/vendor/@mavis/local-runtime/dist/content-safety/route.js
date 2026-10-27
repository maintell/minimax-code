import { json, readJsonBody } from '../api/host-helpers.js';
import { SAFETY_SCENE, } from '@mavis/shared/local-runtime-safety';
const CONTENT_POLICY_VIOLATION = 42201;
const CONTENT_SERVICE_UNAVAILABLE = 50402;
export async function routeLocalContentSafetyApi(input) {
    if (input.method === 'POST' && input.parts.length === 2 && input.parts[1] === 'image') {
        return routeLocalImageSafetyCheck(input);
    }
    if (input.method === 'POST' && input.parts.length === 2 && input.parts[1] === 'text') {
        return routeLocalTextSafetyCheck(input);
    }
    if (input.method !== 'POST' || input.parts.length !== 1) {
        return json({ error: 'Local content safety route not found' }, { status: 404 });
    }
    // Input safety runs in every environment — test included — with no config /
    // env gate. Mirrors the output review, which also reviews unconditionally.
    const body = (await readJsonBody(input.request));
    const content = typeof body.content === 'string' ? body.content : '';
    let attachments;
    try {
        attachments = mapAttachmentsForSafety(Array.isArray(body.attachments) ? body.attachments : undefined);
    }
    catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Invalid content-safety attachment' }, { status: 400 });
    }
    if (!content.trim() && !attachments?.length)
        return json({ pass: true });
    const result = await input.safety.reviewText({
        content,
        attachments,
        scene: SAFETY_SCENE.UserInput,
    });
    return json({
        pass: result.pass,
        reason: result.reason,
        suggestion: result.suggestion,
        ...(!result.pass
            ? {
                // Only a real `rejected` verdict is a policy violation. Any other
                // `pass:false` is an infra error (gateway 5xx `api_error`, or
                // `local_error` = offline / timeout / 4xx auth / no verdict) and
                // surfaces as service-unavailable to this route's synchronous callers
                // (cron / skill pre-check), which show a "try again" toast. Mapping an
                // infra failure to the policy code would falsely tell the user their
                // prompt violates policy when the network failed.
                errorCode: result.errorKind === 'rejected'
                    ? CONTENT_POLICY_VIOLATION
                    : CONTENT_SERVICE_UNAVAILABLE,
            }
            : {}),
    });
}
function mapAttachmentsForSafety(attachments) {
    const items = [];
    for (const attachment of attachments ?? []) {
        const objectKey = typeof attachment.object_key === 'string'
            ? attachment.object_key.trim()
            : typeof attachment.objectKey === 'string'
                ? attachment.objectKey.trim()
                : '';
        const fileUrl = typeof attachment.file_url === 'string'
            ? attachment.file_url.trim()
            : typeof attachment.fileUrl === 'string'
                ? attachment.fileUrl.trim()
                : '';
        if (!objectKey && !fileUrl) {
            throw new Error('content-safety attachment requires one object key or URL');
        }
        if (objectKey && fileUrl) {
            throw new Error('content-safety attachment must use exactly one object key or URL');
        }
        const fileName = typeof attachment.file_name === 'string'
            ? attachment.file_name
            : typeof attachment.fileName === 'string'
                ? attachment.fileName
                : undefined;
        items.push({
            ...(objectKey ? { objectKey } : { fileUrl }),
            ...(fileName ? { fileName } : {}),
        });
    }
    return items.length ? items : undefined;
}
// POST /content/image — V2 image review forwarder. The caller owns the scene
// (e.g. the wallpaper flow sends InterfaceImage=201) and any scene-specific
// gating such as region support; this route only validates the envelope and
// forwards the CDN direct link to biz-gateway `/mavis/api/v2/content`, which
// requires a fetchable http(s) URL and never accepts data URIs. Scene-value
// policy stays with chat-server.
async function routeLocalImageSafetyCheck(input) {
    const body = (await readJsonBody(input.request));
    const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : '';
    if (!isHttpImageUrl(imageUrl)) {
        return json({ error: 'image_url must be an http(s) URL' }, { status: 400 });
    }
    const scene = body.scene;
    if (typeof scene !== 'number' || !Number.isInteger(scene) || scene <= 0) {
        return json({ error: 'scene must be a positive integer' }, { status: 400 });
    }
    try {
        const result = await input.safety.reviewV2({
            scene: scene,
            image_url: imageUrl,
        });
        // Image reviews verdict allow/block; a replace/guide action still means the
        // image must not be persisted, so anything but allow is a policy block.
        if (result.action === 'allow')
            return json({ pass: true });
        return json({
            pass: false,
            reason: 'request rejected',
            errorCode: CONTENT_POLICY_VIOLATION,
        });
    }
    catch {
        // No verdict (offline / auth / gateway degraded / malformed response) fails
        // CLOSED — the image is not persisted — but surfaces as service
        // unavailable, never as a policy violation (same split as the text route).
        return json({
            pass: false,
            reason: 'Service unavailable',
            errorCode: CONTENT_SERVICE_UNAVAILABLE,
        });
    }
}
function isHttpImageUrl(value) {
    if (!value)
        return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    }
    catch {
        return false;
    }
}
// POST /content/text — V2 text review forwarder for user-authored names that
// are persisted outside the runtime (e.g. desktop project aliases send
// ProjectName=211). Like the image route, the caller owns the scene and the
// text: this route only validates the envelope and forwards `content_text`
// unchanged to biz-gateway `/mavis/api/v2/content`. Scene-value policy stays
// with chat-server.
async function routeLocalTextSafetyCheck(input) {
    const body = (await readJsonBody(input.request));
    const contentText = body.content_text;
    if (typeof contentText !== 'string' || !contentText.trim()) {
        return json({ error: 'content_text must be a non-empty string' }, { status: 400 });
    }
    const scene = body.scene;
    if (typeof scene !== 'number' || !Number.isInteger(scene) || scene <= 0) {
        return json({ error: 'scene must be a positive integer' }, { status: 400 });
    }
    try {
        const result = await input.safety.reviewV2({
            scene: scene,
            content_text: contentText,
        });
        // Name writes need an explicit allow; a replace/guide action still means the
        // text must not be persisted, so anything but allow is a policy block.
        if (result.action === 'allow')
            return json({ pass: true });
        return json({
            pass: false,
            reason: 'request rejected',
            errorCode: CONTENT_POLICY_VIOLATION,
        });
    }
    catch {
        // No verdict fails CLOSED — the text is not persisted — but surfaces as
        // service unavailable, never as a policy violation (same split as images).
        return json({
            pass: false,
            reason: 'Service unavailable',
            errorCode: CONTENT_SERVICE_UNAVAILABLE,
        });
    }
}
//# sourceMappingURL=route.js.map