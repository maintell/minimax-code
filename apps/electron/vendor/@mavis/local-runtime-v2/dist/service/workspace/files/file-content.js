import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { Readable } from 'node:stream';
import { getWorkspaceImagePreviewMimeType } from '@mavis/shared/media-asset-meta';
import { officePreviewByteLimit } from '@mavis/shared/office-preview-limits';
import { TEXT_PREVIEW_TOO_LARGE } from '@mavis/shared/text-preview-limits';
import { OfficePreviewSizeError, readOfficePreviewFile } from './preview/office-preview-read.js';
import { MAX_OPEN_FORMAT_PREVIEW_BYTES, readOpenFormatFile } from './preview/open-format-read.js';
import { json, requiredQuery, resolveWorkspacePath, BINARY_EXTENSIONS, TEXT_EXTENSIONS, } from './file-api-shared.js';
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
// Keep aligned with UI open-format-policy.ts. Text diagrams and RFC 822 mail
// retain the existing text path; these formats require their original bytes.
const OPEN_FORMAT_BINARY_EXTENSIONS = new Set('zip rar 7z tar gz tgz bz2 xz ttf otf woff woff2 eot psd psb ai eps ps webarchive sqlite sqlite3 db wasm parquet avro xmind epub ofd xps oxps msg'
    .split(' ')
    .map((extension) => `.${extension}`));
const OPEN_FORMAT_MIME_TYPE = 'application/octet-stream';
const RC_REQUEST_SOURCE_HEADER = 'X-MCode-Request-Source';
const RC_REQUEST_SOURCE_VALUE = 'remote-control';
const RC_FILE_CONTENT_MAX_BYTES_HEADER = 'X-MCode-Remote-Control-File-Content-Max-Bytes';
const DEFAULT_RC_FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;
const PREVIEW_BINARY_MIME_TYPES = new Map([
    ['.aac', 'audio/aac'],
    ['.avif', 'image/avif'],
    ['.bmp', 'image/bmp'],
    // Workbook saves compare the original file hash, including CSV encoding/BOM.
    ['.csv', 'text/csv'],
    ['.doc', 'application/msword'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.flac', 'audio/flac'],
    ['.gif', 'image/gif'],
    ['.key', 'application/vnd.apple.keynote'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.m4a', 'audio/mp4'],
    ['.mkv', 'video/x-matroska'],
    ['.mov', 'video/quicktime'],
    ['.mp3', 'audio/mpeg'],
    ['.mp4', 'video/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.ppt', 'application/vnd.ms-powerpoint'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.svg', 'image/svg+xml'],
    ['.wav', 'audio/wav'],
    ['.webm', 'video/webm'],
    ['.webp', 'image/webp'],
    ['.xls', 'application/vnd.ms-excel'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
]);
export async function streamWorkspaceMedia(absolutePath, contentType, rangeHeader) {
    const info = await stat(absolutePath);
    if (!info.isFile())
        return json({ error: 'File not found', code: 'NOT_FOUND' }, { status: 404 });
    const range = parseSingleByteRange(rangeHeader, info.size);
    if (rangeHeader && !range) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' },
        });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);
    const stream = createReadStream(absolutePath, { start, end });
    return new Response(Readable.toWeb(stream), {
        status: range ? 206 : 200,
        headers: {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
            'Content-Length': String(Math.max(0, end - start + 1)),
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            ...(contentType === 'image/svg+xml'
                ? {
                    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
                }
                : {}),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        },
    });
}
function parseSingleByteRange(value, size) {
    if (!value)
        return null;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
    if (!match || size <= 0)
        return null;
    const startText = match[1] ?? '';
    const endText = match[2] ?? '';
    if (!startText && !endText)
        return null;
    if (!startText)
        return parseSuffixByteRange(endText, size);
    return parseByteRangeBounds(startText, endText, size);
}
function parseSuffixByteRange(endText, size) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
        return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
}
function parseByteRangeBounds(startText, endText, size) {
    const start = Number(startText);
    const requestedEnd = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(requestedEnd) ||
        start < 0 ||
        start >= size ||
        requestedEnd < start) {
        return null;
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
}
export async function serveFilePreview(url, headers, metrics) {
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response)
        return filePath;
    if (filePath.includes('..')) {
        return json({ error: 'Path traversal not allowed' }, { status: 403 });
    }
    const contentType = getWorkspaceImagePreviewMimeType(filePath);
    if (!contentType) {
        return json({ error: 'Only image files are allowed' }, { status: 403 });
    }
    try {
        const info = await stat(filePath);
        if (!info.isFile())
            return json({ error: 'File not found' }, { status: 404 });
        const fileTooLarge = remoteControlFileSizeLimitResponse(headers, info.size, metrics, 'preview');
        if (fileTooLarge)
            return fileTooLarge;
        const data = await readFile(filePath);
        const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return new Response(body, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'private, max-age=300',
            },
        });
    }
    catch {
        return json({ error: 'File not found' }, { status: 404 });
    }
}
export async function readWorkspaceFile(workspace, filePath) {
    return (await readWorkspaceFileOutcome(workspace, filePath)).value;
}
export async function readWorkspaceFileOutcome(workspace, filePath, 
// Only inline content previews opt in; Git diff and line statistics keep their read contract.
textPreviewMaxBytes) {
    const absolute = await resolveWorkspacePath(workspace, filePath);
    if (!absolute) {
        return {
            value: { type: 'binary', content: '', error: 'Path traversal denied' },
            readSucceeded: false,
        };
    }
    const ext = extname(filePath).toLowerCase();
    if (OPEN_FORMAT_BINARY_EXTENSIONS.has(ext)) {
        return readOpenFormatPreviewOutcome(absolute, ext, textPreviewMaxBytes);
    }
    const previewBinaryMime = PREVIEW_BINARY_MIME_TYPES.get(ext);
    const previewLimit = officePreviewByteLimit(filePath);
    const readBytes = () => previewLimit === undefined ? readFile(absolute) : readOfficePreviewFile(absolute, previewLimit);
    if (previewBinaryMime)
        return readBinaryPreviewOutcome(readBytes, previewBinaryMime);
    if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
        return { value: { type: 'binary', content: '' }, readSucceeded: true };
    }
    try {
        const bytes = textPreviewMaxBytes === undefined
            ? await readBytes()
            : await readOfficePreviewFile(absolute, textPreviewMaxBytes);
        return decodeWorkspaceTextOutcome(bytes, ext, textPreviewMaxBytes !== undefined);
    }
    catch (error) {
        if (error instanceof OfficePreviewSizeError) {
            return oversizedPreviewOutcome(error, textPreviewMaxBytes === undefined ? 'office' : 'text');
        }
        return { value: { type: 'text', content: '' }, readSucceeded: false };
    }
}
async function readBinaryPreviewOutcome(readBytes, mimeType) {
    try {
        return {
            value: {
                type: 'binary',
                content: (await readBytes()).toString('base64'),
                encoding: 'base64',
                mimeType,
            },
            readSucceeded: true,
        };
    }
    catch (error) {
        if (error instanceof OfficePreviewSizeError)
            return oversizedPreviewOutcome(error);
        return { value: { type: 'binary', content: '', mimeType }, readSucceeded: false };
    }
}
/** Open formats keep their original bytes; PostScript sources keep the text contract. */
async function readOpenFormatPreviewOutcome(absolute, ext, textPreviewMaxBytes) {
    try {
        const bytes = await readOpenFormatFile(absolute, ext, textPreviewMaxBytes !== undefined);
        // PostScript may be editable source, including legacy Illustrator files.
        // Raw-byte preview support must not change text diff/edit classification.
        const postScriptText = readPostScriptText(bytes, ext);
        if (postScriptText !== undefined) {
            return postScriptTextOutcome(postScriptText, bytes.byteLength, textPreviewMaxBytes);
        }
        const oversized = bytes.byteLength > MAX_OPEN_FORMAT_PREVIEW_BYTES;
        return {
            value: {
                type: 'binary',
                content: oversized ? '' : bytes.toString('base64'),
                ...(oversized ? { error: 'preview_too_large' } : { encoding: 'base64' }),
                mimeType: OPEN_FORMAT_MIME_TYPE,
            },
            readSucceeded: true,
        };
    }
    catch (error) {
        if (error instanceof OfficePreviewSizeError) {
            return {
                value: {
                    type: 'binary',
                    content: '',
                    mimeType: OPEN_FORMAT_MIME_TYPE,
                    error: 'preview_too_large',
                },
                readSucceeded: true,
            };
        }
        return {
            value: { type: 'binary', content: '', mimeType: OPEN_FORMAT_MIME_TYPE },
            readSucceeded: false,
        };
    }
}
function readPostScriptText(bytes, ext) {
    const postScript = ext === '.ps' ||
        ext === '.eps' ||
        (ext === '.ai' && bytes.subarray(0, 4).toString() === '%!PS');
    if (!postScript)
        return undefined;
    const utf16Text = decodeUtf16TextBytes(bytes);
    if (utf16Text !== undefined)
        return utf16Text;
    return isProbablyBinary(bytes) ? undefined : bytes.toString('utf-8');
}
function postScriptTextOutcome(text, sizeBytes, textPreviewMaxBytes) {
    if (textPreviewMaxBytes !== undefined && sizeBytes > textPreviewMaxBytes) {
        return oversizedPreviewOutcome(new OfficePreviewSizeError(sizeBytes, textPreviewMaxBytes), 'text');
    }
    return {
        value: {
            type: 'text',
            content: text,
            ...(textPreviewMaxBytes !== undefined ? { sizeBytes } : {}),
        },
        readSucceeded: true,
    };
}
function decodeWorkspaceTextOutcome(bytes, ext, includeSize) {
    const utf16Text = decodeUtf16TextBytes(bytes);
    if (utf16Text === undefined && !TEXT_EXTENSIONS.has(ext) && isProbablyBinary(bytes)) {
        return { value: { type: 'binary', content: '' }, readSucceeded: true };
    }
    return {
        value: {
            type: 'text',
            content: utf16Text ?? bytes.toString('utf-8'),
            ...(includeSize ? { sizeBytes: bytes.byteLength } : {}),
        },
        readSucceeded: true,
    };
}
function oversizedPreviewOutcome(error, kind = 'office') {
    return {
        value: {
            type: kind === 'text' ? 'text' : 'binary',
            content: '',
            error: kind === 'text' ? 'Text file exceeds the inline preview size limit' : error.message,
            code: kind === 'text' ? TEXT_PREVIEW_TOO_LARGE : error.code,
            sizeBytes: error.sizeBytes,
            maxBytes: error.maxBytes,
        },
        readSucceeded: false,
    };
}
export async function remoteControlFileContentLimitResponse(headers, workspace, filePath, { metrics, route }) {
    if (headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE)
        return undefined;
    const absolute = await resolveWorkspacePath(workspace, filePath);
    if (!absolute)
        return undefined;
    let info;
    try {
        info = await stat(absolute);
    }
    catch {
        return undefined;
    }
    if (!info.isFile())
        return undefined;
    return remoteControlFileSizeLimitResponse(headers, info.size, metrics, route);
}
function remoteControlFileSizeLimitResponse(headers, sizeBytes, metrics, route) {
    if (!headers || headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE) {
        return undefined;
    }
    const maxBytes = readPositiveIntegerHeader(headers, RC_FILE_CONTENT_MAX_BYTES_HEADER) ??
        DEFAULT_RC_FILE_CONTENT_MAX_BYTES;
    if (sizeBytes <= maxBytes)
        return undefined;
    metrics?.incr('remote_control_file_content_rejected_total', {
        reason: 'too_large',
        route,
    });
    return json({
        error: 'File content is too large for remote-control inline response',
        code: 'REMOTE_CONTROL_FILE_CONTENT_TOO_LARGE',
        sizeBytes,
        maxBytes,
    }, { status: 413 });
}
function readPositiveIntegerHeader(headers, name) {
    const raw = headers.get(name);
    if (!raw)
        return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
        return undefined;
    return value;
}
export async function readWorkspaceTextLines(workspace, filePath) {
    const outcome = await readWorkspaceFileOutcome(workspace, filePath);
    if (!outcome.readSucceeded)
        return undefined;
    const content = outcome.value;
    if (content.type !== 'text' || typeof content.content !== 'string')
        return undefined;
    const lines = content.content.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
function isProbablyBinary(bytes) {
    if (bytes.length === 0)
        return false;
    if (bytes.includes(0))
        return true;
    try {
        FATAL_UTF8_DECODER.decode(bytes);
    }
    catch {
        return true;
    }
    const sampleLength = Math.min(bytes.length, 8_000);
    let controlBytes = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const byte = bytes[index];
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)
            controlBytes += 1;
    }
    return controlBytes / sampleLength > 0.3;
}
/**
 * Decodes a byte-order-marked UTF-16 payload into text.
 *
 * Windows-authored text formats (`.inf`, `.reg`, PowerShell output) are
 * routinely UTF-16LE, where every ASCII character carries a NUL padding byte.
 * `isProbablyBinary` rejects any buffer containing NUL, so without this decode
 * such files are reported as binary and never reach the code viewer.
 *
 * Only reached for extensions that are not already known binaries: those return
 * earlier, so a `.bin` that happens to start with `FF FE` stays binary.
 */
function decodeUtf16TextBytes(bytes) {
    if (bytes.length < 4 || bytes.length % 2 !== 0)
        return undefined;
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        text = bytes.subarray(2).toString('utf16le');
    }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        const swapped = Buffer.from(bytes.subarray(2));
        swapped.swap16();
        text = swapped.toString('utf16le');
    }
    else {
        return undefined;
    }
    return isProbablyBinaryText(text) ? undefined : text;
}
/** Control-character heuristic for already-decoded text, mirroring `isProbablyBinary`. */
function isProbablyBinaryText(text) {
    if (text.length === 0)
        return false;
    if (text.includes('\u0000'))
        return true;
    const sampleLength = Math.min(text.length, 8_000);
    let controlChars = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)
            controlChars += 1;
    }
    return controlChars / sampleLength > 0.3;
}
//# sourceMappingURL=file-content.js.map