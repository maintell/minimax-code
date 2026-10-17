/**
 * §4-3 attachments URL download leg (Wave 3 — closes the Wave-2 gap).
 *
 * Phone-side `cmd.session.send` carries `attachments: [{url, mime_type,
 * filename}]` (short MatrixOss URLs, plus allowlisted legacy URLs during the
 * migration); the daemon message input only accepts
 * filePath/dataUrl shapes (`local-runtime/src/messages/input.ts`). filePath is
 * the chosen landing form: downloaded bytes are written under
 * `<userData>/remote-control/attachments/` and the attachment markup carries
 * the on-disk path, so the agent can read the full file during the turn. The
 * validated source URL is discarded after download so bearer credentials never
 * enter Local Runtime Queue or history.
 *
 * Boundaries (plan §4 line 3):
 *   - exact trusted storage hosts only; redirects are never followed
 *   - per-attachment byte cap (default 20MB — the daemon dataUrl leg exposes
 *     no comparable per-file limit, so the plan's fallback value applies) and
 *     a total-batch cap; both enforced via content-length precheck AND a
 *     streaming accumulator (content-length is advisory)
 *   - per-attachment timeout (default 30s, AbortController)
 *   - mime: attachment.mime_type wins; response content-type is the fallback
 *
 * Failure semantics: any attachment failing fails the WHOLE batch (the router
 * then errs the send — no partial sends). Classification:
 *   - malformed entry / non-https URL → ATTACHMENT_UNSUPPORTED (form problem,
 *     retrying won't help)
 *   - size-cap breach → ATTACHMENT_TOO_LARGE (existing router error
 *     vocabulary for 413; a retry won't shrink the file)
 *   - network / timeout / non-2xx / fs write → ATTACHMENT_FETCH_FAILED
 *     (retryable — transient by nature)
 * Files already written for the failed batch are best-effort deleted.
 *
 * Audit hygiene: full URLs never reach the log (CDN URLs are typically
 * presigned) — only hostname + sanitized filename + byte counts.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
export const ATTACHMENT_TIMEOUT_MS = 30_000;
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const FILENAME_MAX_CHARS = 80;
const DEFAULT_MIME = 'application/octet-stream';
const MATRIX_OSS_DOWNLOAD_HOSTS = new Set([
    'matrix-internal-cn.oss-cn-shanghai.aliyuncs.com',
    'matrix-internal.oss-us-east-1.aliyuncs.com',
]);
const LEGACY_UPLOAD_HOSTS = new Set(['cdn.hailuoai.com', 'cdn.hailuoai.video']);
class AttachmentFailure extends Error {
    failure;
    constructor(failure) {
        super(failure.message);
        this.failure = failure;
        this.name = 'AttachmentFailure';
    }
}
function unsupported(message) {
    return new AttachmentFailure({ code: 'ATTACHMENT_UNSUPPORTED', message, retryable: false });
}
function tooLarge(message) {
    return new AttachmentFailure({ code: 'ATTACHMENT_TOO_LARGE', message, retryable: false });
}
function fetchFailed(message) {
    return new AttachmentFailure({ code: 'ATTACHMENT_FETCH_FAILED', message, retryable: true });
}
function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Basename + control-char strip + leading-dot strip + length cap (tail-biased
 * so the extension survives). Never returns an empty string.
 */
export function sanitizeAttachmentFileName(name) {
    const base = (name ?? '').split(/[/\\]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const cleaned = base
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/^\.+/, '')
        .trim();
    const capped = cleaned.length > FILENAME_MAX_CHARS ? cleaned.slice(-FILENAME_MAX_CHARS) : cleaned;
    return capped || 'attachment';
}
function parseAttachment(entry, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw unsupported(`attachment #${index + 1} is not an object`);
    }
    const obj = entry;
    const rawUrl = readString(obj.url);
    if (!rawUrl)
        throw unsupported(`attachment #${index + 1} has no url`);
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw unsupported(`attachment #${index + 1} url is not a valid URL`);
    }
    if (!isTrustedAttachmentURL(url)) {
        throw unsupported(`attachment #${index + 1} url is not a trusted Matrix upload URL`);
    }
    const fileName = sanitizeAttachmentFileName(readString(obj.filename) ??
        readString(obj.file_name) ??
        readString(obj.fileName) ??
        decodeURIComponent(url.pathname.split('/').pop() ?? ''));
    return {
        url,
        fileName,
        mimeType: readString(obj.mime_type) ?? readString(obj.mimeType) ?? '',
    };
}
function isTrustedAttachmentURL(url) {
    if (url.protocol !== 'https:' || url.username || url.password)
        return false;
    const hostname = url.hostname.toLowerCase();
    if (MATRIX_OSS_DOWNLOAD_HOSTS.has(hostname))
        return !url.port && url.pathname.length > 1;
    return LEGACY_UPLOAD_HOSTS.has(hostname);
}
/** Strip content-type parameters: "image/png; charset=binary" → "image/png". */
function mimeFromContentType(header) {
    const value = (header ?? '').split(';')[0]?.trim().toLowerCase();
    return value && value.includes('/') ? value : undefined;
}
async function readBodyCapped(response, capBytes, overCap) {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > capBytes)
        throw overCap();
    if (!response.body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        if (buf.byteLength > capBytes)
            throw overCap();
        return buf;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            total += value.byteLength;
            if (total > capBytes)
                throw overCap();
            chunks.push(value);
        }
    }
    finally {
        // Abandon the rest of an over-cap body instead of draining it.
        await reader.cancel().catch(() => { });
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
export function createAttachmentFetcher(deps) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? ATTACHMENT_TIMEOUT_MS;
    const maxBytes = deps.maxBytesPerAttachment ?? ATTACHMENT_MAX_BYTES;
    const maxTotalBytes = deps.maxTotalBytes ?? ATTACHMENT_MAX_TOTAL_BYTES;
    async function fetchOne(parsed, index, batchDir) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        let bytes;
        try {
            try {
                response = await fetchImpl(parsed.url.toString(), {
                    signal: controller.signal,
                    redirect: 'manual',
                });
            }
            catch (err) {
                const timedOut = controller.signal.aborted;
                throw fetchFailed(timedOut
                    ? `attachment "${parsed.fileName}" timed out after ${timeoutMs}ms (${parsed.url.hostname})`
                    : `attachment "${parsed.fileName}" download failed (${parsed.url.hostname}): ${err instanceof Error ? err.message : String(err)}`);
            }
            if (response.status >= 300 && response.status < 400) {
                throw unsupported(`attachment "${parsed.fileName}" returned a redirect`);
            }
            if (response.url) {
                let responseURL;
                try {
                    responseURL = new URL(response.url);
                }
                catch {
                    throw unsupported(`attachment "${parsed.fileName}" returned an invalid response URL`);
                }
                if (!isTrustedAttachmentURL(responseURL) || responseURL.origin !== parsed.url.origin) {
                    throw unsupported(`attachment "${parsed.fileName}" response left the trusted storage host`);
                }
            }
            if (!response.ok) {
                throw fetchFailed(`attachment "${parsed.fileName}" download returned HTTP ${response.status} (${parsed.url.hostname})`);
            }
            try {
                bytes = await readBodyCapped(response, maxBytes, () => tooLarge(`attachment "${parsed.fileName}" exceeds the ${maxBytes} byte per-file limit`));
            }
            catch (err) {
                if (controller.signal.aborted) {
                    throw fetchFailed(`attachment "${parsed.fileName}" timed out after ${timeoutMs}ms (${parsed.url.hostname})`);
                }
                throw err;
            }
        }
        finally {
            clearTimeout(timer);
        }
        const mimeType = parsed.mimeType || mimeFromContentType(response.headers.get('content-type')) || DEFAULT_MIME;
        const filePath = path.join(batchDir, `${index + 1}-${parsed.fileName}`);
        const temporaryPath = `${filePath}.${randomUUID().slice(0, 8)}.part`;
        try {
            await writeFile(temporaryPath, bytes);
            await rename(temporaryPath, filePath);
        }
        catch (err) {
            await unlink(temporaryPath).catch(() => { });
            throw fetchFailed(`attachment "${parsed.fileName}" could not be written to disk: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {
            file: {
                filePath,
                fileName: parsed.fileName,
                mimeType,
            },
            bytes: bytes.byteLength,
        };
    }
    return {
        async fetchAll(raw) {
            const written = [];
            try {
                const parsed = raw.map(parseAttachment);
                // Per-batch subdirectory: unique paths without touching sibling sends.
                const batchDir = path.join(deps.saveDir, randomUUID().slice(0, 8));
                try {
                    await mkdir(batchDir, { recursive: true });
                }
                catch (err) {
                    throw fetchFailed(`attachment directory could not be created: ${err instanceof Error ? err.message : String(err)}`);
                }
                const attachments = [];
                let totalBytes = 0;
                for (const [index, entry] of parsed.entries()) {
                    const { file, bytes } = await fetchOne(entry, index, batchDir);
                    written.push(file.filePath);
                    totalBytes += bytes;
                    if (totalBytes > maxTotalBytes) {
                        throw tooLarge(`attachments exceed the ${maxTotalBytes} byte total limit`);
                    }
                    attachments.push(file);
                }
                deps.logger.info(`[rc.attachments] downloaded ${attachments.length} attachment(s), ${totalBytes} bytes total`);
                return { ok: true, attachments };
            }
            catch (err) {
                // No partial sends: drop everything this batch already wrote.
                await Promise.all(written.map((p) => unlink(p).catch(() => { })));
                if (err instanceof AttachmentFailure) {
                    deps.logger.warn(`[rc.attachments] batch failed: ${err.failure.code} ${err.message}`);
                    return { ok: false, failure: err.failure };
                }
                const message = err instanceof Error ? err.message : String(err);
                deps.logger.error(`[rc.attachments] unexpected failure: ${message}`);
                return {
                    ok: false,
                    failure: { code: 'ATTACHMENT_FETCH_FAILED', message, retryable: true },
                };
            }
        },
    };
}
//# sourceMappingURL=attachment-fetch.js.map