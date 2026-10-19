/**
 * WeChat (iLink) inbound attachment support: ref extraction, key codec,
 * retry + dead-letter wiring.
 *
 * Migration copy (MR1): attachment half of v1 `channels/wechat.ts`
 * (proposal §4 splits that mixed file). The module-level downloader/DLQ
 * injection slots of the v1 copy were NOT migrated: production installs the
 * real downloader/DLQ into the `wechat/sdk/ilink-download.ts` slots (exposed
 * via the `@mavis/local-runtime-v2/wechat-sdk` subpath), and this resolver
 * receives a per-call downloader through `context.downloader` instead — see
 * MIGRATION-NOTES.
 */
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeDeadLetterCallback, withRetry, } from '../../../delivery/attachment-retry.js';
import { readFirstString } from '../../../record-read.js';
/** Sentinel error code attached to attachments that couldn't be downloaded. */
const WECHAT_ILINK_API_PENDING_ERROR = 'iLink_api_pending';
/**
 * Public alias for the Feishu / Telegram convention. Future-proofs the
 * runner-level error handling so the platform-agnostic side can read
 * `attachment.error` and react without knowing the platform.
 */
const WECHAT_ILINK_API_PENDING_ERROR_MESSAGE = '[TODO] iLink download API not confirmed; see https://vrfi1sk8a0.feishu.cn/docx/WRBtdsLHxovVLyxQ8cTcmlwMnIf for spec';
/**
 * Default stub — rejects with the TODO error. Used when the caller does
 * not supply a per-call `context.downloader` (the real downloader is
 * installed into the `wechat/sdk/ilink-download.ts` slot and threaded
 * through by the adapter; this fallback only fires in unwired paths).
 */
const defaultWeChatAttachmentDownloader = async () => {
    throw new Error(WECHAT_ILINK_API_PENDING_ERROR_MESSAGE);
};
/**
 * Sentinel item-type codes from `ilink-types.MessageItemType`:
 *   TEXT=1, IMAGE=2, VOICE=3, FILE=4, VIDEO=5.
 * Kept as a local constant so the parser doesn't have to import from
 * the electron app.
 */
const WECHAT_ITEM_TYPE = {
    TEXT: 1,
    IMAGE: 2,
    VOICE: 3,
    FILE: 4,
    VIDEO: 5,
};
/**
 * Walk the inbound message's `item_list` and produce one
 * `ChannelInboundAttachmentRef` per non-text attachment. Returns
 * `[]` when there are no attachments or the message shape is
 * unrecognized.
 */
export function extractWeChatAttachmentRefs(body) {
    const payload = isRecord(body.payload) ? body.payload : body;
    const event = isRecord(payload.event) ? payload.event : payload;
    const message = firstRecord(event, ['message', 'msg']) ?? event;
    if (!isRecord(message))
        return [];
    const items = readItemList(message);
    const refs = [];
    for (const item of items) {
        if (!isRecord(item))
            continue;
        const ref = itemToAttachmentRef(item);
        if (ref)
            refs.push(ref);
    }
    return refs;
}
/** One rule per iLink item type; evaluation order matches the v1 if-chain. */
const WECHAT_ITEM_RULES = [
    { itemType: WECHAT_ITEM_TYPE.IMAGE, itemKey: 'image_item', refType: 'image' },
    {
        itemType: WECHAT_ITEM_TYPE.FILE,
        itemKey: 'file_item',
        refType: 'file',
        fixedMime: 'application/octet-stream',
        readsFileName: true,
    },
    {
        itemType: WECHAT_ITEM_TYPE.VOICE,
        itemKey: 'voice_item',
        refType: 'audio',
        fixedName: 'voice.silk',
        fixedMime: 'audio/silk',
    },
    {
        itemType: WECHAT_ITEM_TYPE.VIDEO,
        itemKey: 'video_item',
        refType: 'video',
        fixedName: 'video.mp4',
        fixedMime: 'video/mp4',
    },
];
function itemToAttachmentRef(item) {
    const rule = WECHAT_ITEM_RULES.find((candidate) => candidate.itemType === item.type);
    if (!rule)
        return undefined;
    const raw = item[rule.itemKey];
    if (!isRecord(raw))
        return undefined;
    const subitem = raw;
    const media = isRecord(subitem.media) ? subitem.media : {};
    if (rule.refType === 'image')
        return imageItemRef(subitem, media);
    const key = encodeWeChatAttachmentKey({
        encryptedQueryParam: readFirstString(media, ['encrypt_query_param']),
        aesKey: readFirstString(media, ['aes_key']),
    });
    if (!key)
        return undefined;
    const name = rule.readsFileName
        ? (readFirstString(subitem, ['file_name']) ?? 'file')
        : rule.fixedName;
    return {
        type: rule.refType,
        key,
        ...(name ? { name } : {}),
        ...(rule.fixedMime ? { mimeType: rule.fixedMime } : {}),
    };
}
/**
 * iLink ships the image aes-key as a 32-char hex string under
 * `image_item.aeskey`, but the CDN downloader's `parseAesKey` expects
 * base64. Convert here so inbound image download doesn't fail with
 * `aes_key must decode to 16 raw bytes or 32-char hex string, got 24
 * bytes` (parity with historical `imGateway/platforms/wechat.ts`).
 */
function imageItemRef(subitem, media) {
    const aesKey = normalizeWeChatAesKey(readFirstString(subitem, ['aeskey']), readFirstString(media, ['aes_key']));
    const encryptedQueryParam = readFirstString(media, ['encrypt_query_param']) ?? readFirstString(subitem, ['url']);
    const key = encodeWeChatAttachmentKey({ encryptedQueryParam, aesKey });
    if (!key)
        return undefined;
    return {
        type: 'image',
        key,
        ...(aesKey ? { name: 'image.jpg', mimeType: 'image/jpeg' } : {}),
    };
}
function encodeWeChatAttachmentKey(input) {
    const encryptedQueryParam = input.encryptedQueryParam?.trim() ?? '';
    if (!encryptedQueryParam)
        return '';
    const aesKey = input.aesKey?.trim() ?? '';
    return aesKey ? `${aesKey}|${encryptedQueryParam}` : encryptedQueryParam;
}
export function decodeWeChatAttachmentKey(key) {
    const idx = key.indexOf('|');
    if (idx < 0)
        return { encryptedQueryParam: key, aesKey: '' };
    return { aesKey: key.slice(0, idx), encryptedQueryParam: key.slice(idx + 1) };
}
/**
 * Pick the right aes-key encoding for the CDN downloader:
 *   - `media.aes_key` is base64(raw 16) — pass through
 *   - `image_item.aeskey` is hex(raw 16) — re-encode to base64
 *
 * The CDN helper's `parseAesKey` only accepts base64 (of either the raw
 * 16-byte key or its 32-char hex form). Without this normalisation, inbound
 * images fail to decrypt with `aes_key must decode to 16 raw bytes or
 * 32-char hex string, got 24 bytes` (24 = `Buffer.from(<hex>, 'base64')`
 * misreading the hex as base64). Parity with historical
 * `imGateway/platforms/wechat.ts` which performed the identical
 * `Buffer.from(aeskey, 'hex').toString('base64')` round-trip.
 */
function normalizeWeChatAesKey(rawHex, rawBase64) {
    if (rawHex && /^[0-9a-fA-F]{32}$/.test(rawHex)) {
        return Buffer.from(rawHex, 'hex').toString('base64');
    }
    if (rawBase64)
        return rawBase64;
    return rawHex;
}
/**
 * Persist an inbound WeChat attachment buffer under
 * `<dataDir>/tmp/im-attachments/<scope>/<ts>-<file>` and return the absolute
 * path. Mirrors the Telegram downloader's on-disk convention so the agent
 * loop can hand the file to v2 input materialization the same way.
 */
export async function writeWeChatAttachmentFile(input) {
    const scope = sanitizeAttachmentSegment(input.scopeDirName || 'wechat');
    const safeName = sanitizeAttachmentSegment(input.fileName || 'attachment');
    const dir = join(input.dataDir, 'tmp', 'im-attachments', scope);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${Date.now()}-${safeName}`);
    await writeFile(target, input.buffer, { mode: 0o600 });
    return target;
}
function sanitizeAttachmentSegment(value) {
    return value.replace(/[^a-zA-Z0-9._:-]/g, '_') || 'attachment';
}
/**
 * Resolve a list of `ChannelInboundAttachmentRef` into
 * `LocalMessageAttachment[]`. Failed downloads are turned into
 * marker attachments with `error: 'iLink_api_pending'` so the main
 * message still flows through to the agent loop.
 */
export async function resolveWeChatAttachments(refs, context) {
    if (refs.length === 0)
        return [];
    const results = await Promise.all(refs.map(async (ref) => resolveOneWeChatAttachment(ref, context)));
    return results;
}
async function resolveOneWeChatAttachment(ref, context) {
    const baseType = ref.type === 'image' ? 'image' : 'file';
    const fallbackName = ref.name ?? `${ref.type}-${context.messageId}`;
    const fallbackMime = ref.mimeType ?? 'application/octet-stream';
    const dlqMeta = {
        platform: 'wechat',
        sessionId: context.sessionId ?? '',
        messageId: context.messageId,
        refKind: mapChannelRefTypeToDlqRefKind(ref.type),
        refKey: ref.key,
    };
    try {
        // P2-B: 单次下载包一层 withRetry + DLQ。默认 iLink_api_pending 是业务级
        // pending, 自愈无意义, 走 isPermanentError 直接 DLQ 一次不再重试; 真实
        // 实现接入后 (HTTP 5xx / 网络抖动), 走指数退避。
        // No module-level slot on the v2 inbound side: the adapter passes the
        // wired downloader per call; absent that, fail with the pending-API stub.
        const downloader = context.downloader ?? defaultWeChatAttachmentDownloader;
        const result = await withRetry(() => downloader(ref, {
            messageId: context.messageId,
            sessionId: context.sessionId ?? '',
            clientName: context.clientName ?? '',
            ...(context.contextToken ? { contextToken: context.contextToken } : {}),
            ...(context.botToken ? { botToken: context.botToken } : {}),
            ...(context.baseUrl ? { baseUrl: context.baseUrl } : {}),
        }), {
            maxAttempts: 3,
            backoffMs: [500, 1500, 5000],
            isPermanentError: (err) => isIlinkApiPendingError(err),
        }, 
        // v2 inbound side has no DLQ injection slot (the v1 slot was not
        // migrated; DLQ wiring lives in wechat/sdk/ilink-download.ts) —
        // `undefined` selects makeDeadLetterCallback's silent no-op branch.
        makeDeadLetterCallback(undefined, dlqMeta));
        return {
            type: baseType,
            filePath: result.filePath,
            fileName: fallbackName,
            mimeType: result.mimeType || fallbackMime,
        };
    }
    catch {
        return {
            type: baseType,
            filePath: '',
            fileName: fallbackName,
            mimeType: fallbackMime,
            error: WECHAT_ILINK_API_PENDING_ERROR,
        };
    }
}
/**
 * P2-B: iLink 默认 throw 的两条 error message 都包含 "iLink" 关键词且
 * 语义是 "业务方还没确认", 一律按永久错误处理 (不重试)。真实实现接入
 * 后, 这些关键字不会再出现, 走默认 HTTP 4xx/5xx 判定。
 */
function isIlinkApiPendingError(err) {
    if (!(err instanceof Error))
        return false;
    const msg = err.message;
    return (msg.includes('iLink_api_pending') ||
        msg.includes(WECHAT_ILINK_API_PENDING_ERROR_MESSAGE) ||
        msg.includes('iLink download API not confirmed'));
}
/** ChannelInboundAttachmentRef.type (image | file | audio | video) → DLQ refKind。 */
function mapChannelRefTypeToDlqRefKind(type) {
    switch (type) {
        case 'image':
            return 'image';
        case 'video':
            return 'video';
        case 'audio':
            return 'voice';
        case 'file':
        default:
            return 'file';
    }
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
//# sourceMappingURL=wechat-attachment-support.js.map