export function extractFeishuAttachmentRefs(body, messageType, contentOverride) {
    const payload = isRecord(body.payload) ? body.payload : body;
    const event = isRecord(payload.event) ? payload.event : payload;
    const message = isRecord(event.message) ? event.message : event;
    const content = isRecord(contentOverride) ? contentOverride : safeJsonObject(message?.content);
    if (!content)
        return [];
    const effectiveType = resolveEffectiveType(messageType, content);
    const single = singleResourceRef(effectiveType, content);
    if (single)
        return [single];
    if (effectiveType === 'post' || Array.isArray(content.content)) {
        return extractPostRefs(content);
    }
    return [];
}
/**
 * Feishu's top-level video event is reported as `media` while still carrying
 * `file_key`. Post rich-text `tag=media` remains a generic file ref below.
 */
function resolveEffectiveType(messageType, content) {
    const mt = (messageType ?? '').toLowerCase();
    if (mt === 'media' && typeof content.file_key === 'string' && content.file_key)
        return 'video';
    if (mt)
        return mt;
    return inferContentType(content);
}
function safeJsonObject(value) {
    if (isRecord(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function inferContentType(content) {
    if (typeof content.image_key === 'string' && content.image_key)
        return 'image';
    if (typeof content.file_key === 'string' && content.file_key)
        return 'file';
    return '';
}
/** keyField/defaultName per single-resource message type (v1 branch table). */
const SINGLE_RESOURCE_RULES = {
    image: { keyField: 'image_key' },
    file: { keyField: 'file_key' },
    audio: { keyField: 'file_key', defaultName: 'audio.opus' },
    video: { keyField: 'file_key', defaultName: 'video.mp4' },
};
function singleResourceRef(effectiveType, content) {
    const rule = SINGLE_RESOURCE_RULES[effectiveType];
    if (!rule)
        return undefined;
    const key = content[rule.keyField];
    if (typeof key !== 'string' || !key)
        return undefined;
    const name = typeof content.file_name === 'string' ? content.file_name : rule.defaultName;
    return {
        type: effectiveType,
        key,
        name,
    };
}
function extractPostRefs(content) {
    const refs = [];
    const postContent = (content.zh_cn ?? content.en_us ?? content);
    const lines = Array.isArray(postContent.content) ? postContent.content : [];
    for (const line of lines) {
        if (!Array.isArray(line))
            continue;
        for (const item of line) {
            const ref = postItemRef(item);
            if (ref)
                refs.push(ref);
        }
    }
    return refs;
}
/** img → image ref; rich-text media → generic file ref (v1 semantics). */
function postItemRef(item) {
    if (!isRecord(item))
        return undefined;
    if (item.tag === 'img' && typeof item.image_key === 'string' && item.image_key) {
        return { type: 'image', key: item.image_key };
    }
    if (item.tag === 'media' && typeof item.file_key === 'string' && item.file_key) {
        return { type: 'file', key: item.file_key, name: item.file_name };
    }
    return undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=feishu-attachments.js.map