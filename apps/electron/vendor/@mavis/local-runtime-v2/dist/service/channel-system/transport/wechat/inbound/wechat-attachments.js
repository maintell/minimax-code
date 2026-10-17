const TEXT_KEY_DELIMITER = '|';
/**
 * Extract attachment refs from an iLink inbound message. Each ref carries
 * `encryptedQueryParam` + `aesKey` joined with `|` so the platform-agnostic
 * `ChannelInboundAttachmentRef.key` slot transports both halves.
 */
export function extractWeChatAttachmentRefs(body) {
    const payload = isRecord(body['payload']) ? body['payload'] : body;
    const event = isRecord(payload['event']) ? payload['event'] : payload;
    const message = firstRecord(event, ['message', 'msg']) ?? event;
    if (!isRecord(message))
        return [];
    const items = readItemList(message);
    const refs = [];
    for (const item of items) {
        if (!isRecord(item))
            continue;
        const refType = itemRefType(item['type']);
        if (refType)
            refs.push(refFromMedia(item, refType));
    }
    return refs.filter((ref) => Boolean(ref?.key));
}
/** iLink numeric item codes with their string aliases (v1 if-chain order). */
function itemRefType(type) {
    if (type === 2 || type === 'image')
        return 'image';
    if (type === 3 || type === 'voice')
        return 'audio';
    if (type === 4 || type === 'file')
        return 'file';
    if (type === 5 || type === 'video')
        return 'video';
    return undefined;
}
function encodeAttachmentKey(parts) {
    return `${parts.aesKey}${TEXT_KEY_DELIMITER}${parts.encryptedQueryParam}`;
}
export function decodeAttachmentKey(key) {
    const idx = key.indexOf(TEXT_KEY_DELIMITER);
    if (idx < 0)
        return { aesKey: '', encryptedQueryParam: key };
    return {
        aesKey: key.slice(0, idx),
        encryptedQueryParam: key.slice(idx + 1),
    };
}
/**
 * Load a media file (or `data:` URL) into a `Buffer`. The adapter calls this
 * once per outbound media item before handing the bytes to the SDK uploader.
 */
export async function readMediaBuffer(path) {
    if (path.startsWith('data:')) {
        const base64 = path.split(',', 2)[1] ?? '';
        return Buffer.from(base64, 'base64');
    }
    const { readFile } = await import('node:fs/promises');
    return readFile(path);
}
export function extractFileName(path) {
    if (path.startsWith('data:'))
        return 'media';
    const parts = path.split(/[\\/]/u);
    return parts[parts.length - 1] ?? 'media';
}
export function guessMimeFromKind(kind) {
    switch (kind) {
        case 'image':
            return 'image/png';
        case 'video':
            return 'video/mp4';
        case 'audio':
            return 'audio/ogg';
        default:
            return 'application/octet-stream';
    }
}
// --- internal helpers --------------------------------------------------------
function refFromMedia(item, type) {
    const subitem = pickMediaSubItem(item);
    const media = isRecord(subitem['media']) ? subitem['media'] : undefined;
    const encryptedQueryParam = readString(media ?? {}, ['encrypt_query_param']) ?? '';
    // iLink ships two aes-key flavours:
    //   - `image_item.aeskey`  — hex string of the raw 16-byte key
    //   - `*.media.aes_key`    — base64 of the raw 16 bytes (file / voice / video)
    // The CDN download helper (`parseAesKey`) expects base64, so normalise the
    // hex flavour to base64 here. Without this, image inbound fails with
    // `aes_key must decode to 16 raw bytes or 32-char hex string, got 24 bytes`
    // when the hex string is mis-interpreted as base64 (parity with historical
    // `imGateway/platforms/wechat.ts` which did the exact same conversion).
    const aesKey = pickAesKey(readString(subitem, ['aeskey']), readString(media ?? {}, ['aes_key']));
    const key = encodeAttachmentKey({ encryptedQueryParam, aesKey });
    const ref = { type, key };
    const name = readString(subitem, ['file_name']);
    if (name)
        ref.name = name;
    const size = readNumber(subitem, ['mid_size', 'video_size', 'len']);
    if (size !== undefined)
        ref.size = size;
    return ref;
}
function readString(raw, keys) {
    if (!raw)
        return undefined;
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function readNumber(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string') {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
function firstRecord(raw, keys) {
    for (const key of keys) {
        if (isRecord(raw[key]))
            return raw[key];
    }
    return undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** iLink puts attachments under `item_list` (snake) or `items` (camel). */
function readItemList(message) {
    if (Array.isArray(message['item_list']))
        return message['item_list'];
    if (Array.isArray(message['items']))
        return message['items'];
    return [];
}
/** First media sub-record in iLink's fixed order; falls back to the item. */
function pickMediaSubItem(item) {
    for (const key of ['image_item', 'voice_item', 'file_item', 'video_item']) {
        const candidate = item[key];
        if (isRecord(candidate))
            return candidate;
    }
    return item;
}
/**
 * iLink ships two aes-key flavours: `image_item.aeskey` (hex of the raw 16
 * bytes) and `*.media.aes_key` (base64). The CDN download helper expects
 * base64, so the hex flavour is re-encoded; an unexpected encoding passes
 * through so `parseAesKey` can throw clearly.
 */
function pickAesKey(rawAesHex, rawAesB64) {
    if (rawAesHex && /^[0-9a-fA-F]{32}$/.test(rawAesHex)) {
        return Buffer.from(rawAesHex, 'hex').toString('base64');
    }
    if (rawAesB64)
        return rawAesB64;
    return rawAesHex ?? '';
}
//# sourceMappingURL=wechat-attachments.js.map