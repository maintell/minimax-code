/**
 * Migration copy (MR1) of v1 `channels/adapters/telegram/telegram-attachment-downloader.ts`.
 */
import { detach, settleOr, settleOrUndefined, settleQuietly } from '../../settle.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { makeDeadLetterCallback, withRetry, } from '../../delivery/attachment-retry.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { detectMediaFromBuffer, hasValidIsoBmffFileTypeBox, } from '../../ingress/media/media-detector.js';
export {} from '../../ingress/media/media-detector.js';
const TELEGRAM_KIND_SPECS = {
    photo: { category: 'image', fallback: { mimeType: 'image/jpeg', extension: 'jpg' } },
    document: {
        category: 'file',
        fallback: { mimeType: 'application/octet-stream', extension: 'bin' },
    },
    voice: { category: 'audio', fallback: { mimeType: 'audio/ogg', extension: 'ogg' } },
    audio: { category: 'audio', fallback: { mimeType: 'audio/mpeg', extension: 'mp3' } },
    video: { category: 'video', fallback: { mimeType: 'video/mp4', extension: 'mp4' } },
    sticker: { category: 'image', fallback: { mimeType: 'image/webp', extension: 'webp' } },
};
/** Pick a MIME / extension pair from the buffer, falling back to a kind-specific default. */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function detectMediaOrFallback(buffer, kind) {
    const detected = detectMediaFromBuffer(buffer);
    if (detected)
        return detected;
    if (hasValidIsoBmffFileTypeBox(buffer)) {
        return { mimeType: 'application/octet-stream', extension: 'bin' };
    }
    return TELEGRAM_KIND_SPECS[kind].fallback;
}
/**
 * Convert a Telegram kind spec into the runner-level `LocalMessageAttachment.type`.
 * Image-bearing kinds (photo, sticker) map to `'image'`; everything else falls
 * back to `'file'` per the `LocalMessageAttachment` type union.
 */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function categoryForKind(kind) {
    const category = TELEGRAM_KIND_SPECS[kind].category;
    return category === 'image' ? 'image' : 'file';
}
/**
 * Pick the largest-size variant out of a Telegram `message.photo` array. The
 * Bot API delivers photos as a sorted array of `PhotoSize` objects; the last
 * entry has the highest `width`/`height`/`file_size`.
 */
export function pickLargestPhoto(photo) {
    if (!Array.isArray(photo) || photo.length === 0)
        return undefined;
    return photo[photo.length - 1];
}
const TELEGRAM_API_BASE = 'https://api.telegram.org';
/**
 * Telegram inbound attachment downloader (P1-C, scheme §4.5).
 *
 * Two-step download protocol (per Telegram Bot API docs):
 *   1. `GET /bot{token}/getFile?file_id={file_id}` → returns `file_path`.
 *   2. `GET /file/bot{token}/{file_path}` → binary blob.
 *
 * Failures (non-2xx HTTP, empty body, missing `file_path`) resolve the
 * returned `Promise<LocalMessageAttachment>` with an `error` field rather
 * than rejecting — the inbound handler treats each attachment as
 * best-effort and never blocks the parent message on a failed download.
 */
export class TelegramAttachmentDownloader {
    botToken;
    dataDir;
    fetcher;
    makeId;
    nowMs;
    scopeDirName;
    retry;
    deadLetterStore;
    /** 调用方 (inbound handler) 在调用 downloadAttachment 之前设置的运行时上下文。 */
    currentContext;
    constructor(options) {
        this.botToken = options.botToken;
        this.dataDir = options.dataDir;
        this.fetcher = options.fetcher ?? fetch;
        const defaultMakeId = () => randomBytes(4).toString('base64url').slice(0, 6);
        this.makeId = options.makeId ?? defaultMakeId;
        this.nowMs = options.nowMs ?? Date.now;
        this.scopeDirName = options.scopeDirName ?? 'pending';
        this.retry = options.retry ?? {};
        this.deadLetterStore = options.deadLetterStore;
    }
    /**
     * 设置本次下载的运行时上下文 (sessionId / messageId),供死信队列记录使用。
     * 调用方在调用 `downloadAttachment` 前**必须**先调用一次;不调则 DLQ
     * 字段留空字符串 ("sessionId=unknown"),不影响主流程。
     *
     * 同一个 downloader 实例是 long-lived 的(inbound handler 复用),所以
     * 每次 inbound 调用都要重设。建议在 inbound 入口处:
     *
     *   await downloader.withDownloadContext({ sessionId, messageId }, async () => {
     *     const attachments = await Promise.all(refs.map((r) => downloader.downloadAttachment(kind, r)));
     *   });
     */
    async withDownloadContext(ctx, fn) {
        const prev = this.currentContext;
        this.currentContext = ctx;
        try {
            return await fn();
        }
        finally {
            this.currentContext = prev;
        }
    }
    /**
     * Download a single Telegram attachment (any of the six supported kinds).
     * Returns a `LocalMessageAttachment` with `filePath` set on success or
     * `error: 'download_failed'` on failure. Never throws.
     *
     * P2-B:网络抖动 / HTTP 5xx / 超时会按 `retry` 配置 (默认 3 次 +
     * [500, 1500, 5000] ms 退避) 自动重试;4xx 与"协议级错误"
     * (malformed getFile body、空 body) 视为永久错误不重试。所有重试
     * 都失败后,失败上下文会被记入 `deadLetterStore` (若已配置),最后
     * 仍 resolve 为带 `error` 的 attachment,主流程不阻塞。
     */
    async downloadAttachment(kind, ref) {
        const trace = (message) => {
            logger.info({ operation: 'telegram_attachment_download', message }, 'Telegram attachment trace');
        };
        const fileId = ref.key;
        if (!fileId) {
            // missing file_id 是协议级错误,不可重试,不进 DLQ (除非调用方手动 catch)
            return failedAttachment(kind, ref, 'download_failed: missing file_id', trace);
        }
        let buffer;
        try {
            buffer = await withRetry(() => this.fetchBuffer(ref, trace), this.retry, this.makeOnDeadLetter(kind, ref, trace));
        }
        catch (err) {
            // withRetry 已把最后一次失败 throw 出来 — 不论是"永久错误一次性放弃"
            // 还是"重试耗尽",都走统一的 failedAttachment 路径。DLQ 已在 onDeadLetter 里记。
            return failedAttachment(kind, ref, `download_failed: ${errorMessage(err)}`, trace);
        }
        const detected = detectMediaOrFallback(buffer, kind);
        const filename = this.deriveFilename(ref, detected.extension);
        const fullPath = join(this.attachmentDir(), filename);
        try {
            await mkdir(this.attachmentDir(), { recursive: true });
            await writeFile(fullPath, buffer);
        }
        catch (err) {
            // 落盘失败一般是磁盘满 / 权限问题,不可重试,但记入 DLQ 供排查
            const reason = `cannot persist: ${errorMessage(err)}`;
            this.fireDeadLetter(kind, ref, reason, trace);
            return failedAttachment(kind, ref, `download_failed: ${reason}`, trace);
        }
        trace(`downloaded kind=${kind} fileId=${fileId} bytes=${buffer.length} mimeType=${detected.mimeType} filePath=${fullPath}`);
        return {
            type: categoryForKind(kind),
            filePath: fullPath,
            fileName: filename,
            mimeType: detected.mimeType,
        };
    }
    /**
     * 构造本次下载的死信回调。把 Telegram-specific 字段 (kind / ref)
     * 提到闭包外,sessionId/messageId 从 `currentContext` 读(在重试过程中
     * 不会变)。
     */
    makeOnDeadLetter(kind, ref, trace) {
        if (!this.deadLetterStore)
            return undefined;
        const refKind = mapTelegramKindToDlqRefKind(kind);
        const ctx = this.currentContext;
        const cb = makeDeadLetterCallback(this.deadLetterStore, {
            platform: 'telegram',
            sessionId: ctx?.sessionId ?? '',
            messageId: ctx?.messageId ?? '',
            refKind,
            refKey: ref.key,
        });
        return (err, attempt, chain) => {
            trace(`dead-letter ${kind} ${ref.key} after ${attempt} attempt(s): ${errorMessage(err)}`);
            return cb(err, attempt, chain);
        };
    }
    /**
     * 非重试路径上"也希望记入 DLQ"的兜底 (落盘失败 / 协议级错误)。把
     * `finalError` 当作单元素 errorChain 写入,与重试路径的链式结构保持
     * 一致。
     */
    fireDeadLetter(kind, ref, reason, trace) {
        if (!this.deadLetterStore)
            return;
        const refKind = mapTelegramKindToDlqRefKind(kind);
        const ctx = this.currentContext;
        // DLQ write is fire-and-forget: `record` owns its own persistence errors.
        detach(settleQuietly(this.deadLetterStore.record({
            ts: this.nowMs(),
            platform: 'telegram',
            sessionId: ctx?.sessionId ?? '',
            messageId: ctx?.messageId ?? '',
            refKind,
            refKey: ref.key,
            errorChain: [{ attempt: 1, message: reason }],
            finalError: reason,
        })));
        trace(`dead-letter ${kind} ${ref.key}: ${reason}`);
    }
    /**
     * 内部 fetch 步骤 — 只做 HTTP 调用与 body 解析,**不**做持久化。
     * 抛出的错误必须带可识别的 status / message,以便 `withRetry` 判定
     * 是否可重试:
     *   - fetcher reject (网络错) → 默认可重试
     *   - HTTP 5xx → 默认可重试
     *   - HTTP 4xx → 永久 (抛 `status` 字段,`withRetry` 把它认作 4xx)
     *   - JSON parse / file_path 缺失 / 空 body → 永久
     */
    async fetchBuffer(ref, trace) {
        const fileId = ref.key;
        let getFileResponse;
        try {
            getFileResponse = await this.fetcher(`${TELEGRAM_API_BASE}/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { method: 'GET' });
        }
        catch (err) {
            throw wrapWithHttpStatus(err, 0);
        }
        if (!getFileResponse.ok) {
            await throwHttpStatusError(getFileResponse, 'getFile');
        }
        const getFileData = (await settleOrUndefined(getFileResponse.json()));
        const filePath = getFileData?.result?.file_path;
        if (!getFileData?.ok || !filePath) {
            // 协议级错误:Bot API 返回的 ok=false 或缺 file_path,重试无意义
            throw new Error(`getFile returned no file_path (${getFileData?.description ?? 'malformed response'})`);
        }
        let downloadResponse;
        try {
            downloadResponse = await this.fetcher(`${TELEGRAM_API_BASE}/file/bot${this.botToken}/${filePath}`, { method: 'GET' });
        }
        catch (err) {
            throw wrapWithHttpStatus(err, 0);
        }
        if (!downloadResponse.ok) {
            await throwHttpStatusError(downloadResponse, 'file');
        }
        const arrayBuffer = await settleOr(downloadResponse.arrayBuffer(), null);
        if (!arrayBuffer) {
            // arrayBuffer() reject 通常是解码错,不可重试
            throw new Error('empty body (arrayBuffer() rejected)');
        }
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length === 0) {
            // 服务端 200 + 空 body,通常不是网络抖动,重试意义不大
            throw new Error('empty body');
        }
        trace(`fetched ${fileId} (${buffer.length} bytes)`);
        return buffer;
    }
    /**
     * Convenience wrapper: download a batch of refs concurrently. Each download
     * is independent — a single failure does not affect the others.
     */
    async downloadAll(items) {
        return Promise.all(items.map((item) => this.downloadAttachment(item.kind, item.ref)));
    }
    /** Resolve the directory used to persist downloaded attachments. */
    attachmentDir() {
        return join(this.dataDir(), 'tmp', 'im-attachments', this.scopeDirName);
    }
    /**
     * Compose the on-disk filename for a download. We honour a caller-provided
     * `name` when it carries an extension (e.g. `report.pdf`); otherwise we
     * fall back to `{id}.{ext}`. The id is the same 6-char base64url token the
     * Feishu downloader emits, which keeps cleanup tooling uniform.
     */
    deriveFilename(ref, ext) {
        if (ref.name && extname(ref.name)) {
            // Strip path components — the platform-supplied name is treated as
            // opaque, never as a relative path.
            const base = ref.name.replace(/^.*[\\/]/u, '');
            if (base)
                return base;
        }
        return `${this.makeId()}.${ext}`;
    }
}
function failedAttachment(kind, ref, reason, trace) {
    trace(`failed ${kind} ${ref.key}: ${reason}`);
    const fallback = TELEGRAM_KIND_SPECS[kind].fallback;
    return {
        type: categoryForKind(kind),
        filePath: '',
        fileName: ref.name ?? `${kind}-${ref.key.slice(0, 6) || 'unknown'}`,
        mimeType: fallback.mimeType,
        error: reason,
    };
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * 把 fetcher reject 的错误包一层,带上我们刚才设的 status。`fetch` 自身
 * 不会 reject with status(只在 `response.ok === false` 时才有),所以这
 * 里只是为了保留 message,给 `withRetry` 一个明确的"网络错误"信号
 * (没有 status → 走默认非 4xx → 默认可重试)。
 */
function wrapWithHttpStatus(err, _status) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(msg);
}
/**
 * 把 Telegram 特有的 6 种 kind 映射到 DLQ 的 4 种 refKind
 * (image / file / audio / video)。`sticker` / `photo` 归 image,
 * `voice` / `audio` 归 audio,`video` 归 video,`document` 归 file。
 */
function mapTelegramKindToDlqRefKind(kind) {
    switch (kind) {
        case 'photo':
        case 'sticker':
            return 'image';
        case 'voice':
        case 'audio':
            return 'voice';
        case 'video':
            return 'video';
        case 'document':
        default:
            return 'file';
    }
}
/** 把 status 暴露给 withRetry,后者会用它判定是否 4xx 永久错误。 */
async function throwHttpStatusError(response, operation) {
    const status = response.status;
    try {
        await response.text();
    }
    catch {
        /* ignore — body drain is best-effort */
    }
    const err = new Error(`${operation} HTTP ${status} ${response.statusText}`);
    err.status = status;
    throw err;
}
//# sourceMappingURL=telegram-attachment-downloader.js.map