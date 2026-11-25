import { createHash } from 'node:crypto';
/**
 * Host-neutral naming and encoding of externalized tool output. Desktop and
 * Cloud artifact stores share these so one tool result keeps the same names,
 * digests and readable rows regardless of where the bytes are written.
 * Nothing here touches a file system.
 */
// A worst-case JSON escape uses six characters (for example, "\u0000").
// 240 code points plus the JSONL envelope therefore stays below the read cap.
const READABLE_CHUNK_CODE_POINTS = 240;
const READABLE_FORMAT_VERSION = 1;
// At most 64 KiB for one UTF-8 conversion even if every UTF-16 code unit is
// encoded independently as a three-byte replacement character.
const RAW_WRITE_CHUNK_CODE_UNITS = 16 * 1_024;
export const TOOL_OUTPUT_READABLE_FORMAT = `chunked_jsonl_v${READABLE_FORMAT_VERSION}`;
/**
 * Stable names for one tool result. The caller's storage already scopes
 * artifacts to a Session; the projecting turn is excluded so the same
 * historical tool result keeps one stable name.
 */
export function toolOutputArtifactNames(input) {
    const contentSha256 = sha256Text(input.text);
    // 分片文件名同时带上工具名和位置，能看出它属于哪次调用的哪一项：
    // `web_search-<call>-result-01-<sha256>.txt`。
    const baseName = input.part
        ? `${fileNameSegment(input.toolName)}-${toolOutputCallDigest(input)}-${fileNameSegment(input.part)}-${contentSha256}`
        : `${toolOutputCallDigest(input)}-${contentSha256}`;
    return {
        fileName: `${baseName}.txt`,
        readableFileName: `${baseName}.readable.v${READABLE_FORMAT_VERSION}.jsonl`,
        contentSha256,
    };
}
function fileNameSegment(value) {
    return value.replaceAll(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64) || 'part';
}
/** Stable name for one archived image, from its decoded bytes' SHA-256. */
export function toolOutputImageArtifactName(input) {
    return `${toolOutputCallDigest(input)}-${input.contentSha256}.${imageExtension(input.mimeType)}`;
}
/**
 * Whether the host's `read` tool would truncate a physical line, so a readable
 * copy is needed. The host passes its own read contract's per-line limit.
 */
export function hasLineExceedingReadLimit(text, maxLineChars) {
    let lineCodePoints = 0;
    for (const char of text) {
        if (char === '\n') {
            lineCodePoints = 0;
            continue;
        }
        lineCodePoints += 1;
        if (lineCodePoints > maxLineChars)
            return true;
    }
    return false;
}
/** JSONL rows of the readable copy: one header, then bounded text chunks. */
export function* readableArtifactLines(text, identity) {
    yield `${JSON.stringify({
        type: 'tool_output_chunks',
        version: READABLE_FORMAT_VERSION,
        original_bytes: identity.originalBytes,
        content_sha256: identity.contentSha256,
        instruction: "Concatenate each chunk row's text field in index order.",
    })}\n`;
    let index = 0;
    let byteOffset = 0;
    let chunk = '';
    let chunkCodePoints = 0;
    for (const char of text) {
        chunk += char;
        chunkCodePoints += 1;
        if (chunkCodePoints < READABLE_CHUNK_CODE_POINTS)
            continue;
        yield encodeReadableChunk(index, byteOffset, chunk);
        byteOffset += Buffer.byteLength(chunk);
        index += 1;
        chunk = '';
        chunkCodePoints = 0;
    }
    if (chunk || text === '')
        yield encodeReadableChunk(index, byteOffset, chunk);
}
/** Splits text into pieces whose UTF-8 encoding stays bounded, never splitting a surrogate pair. */
export function* boundedTextChunks(text) {
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + RAW_WRITE_CHUNK_CODE_UNITS, text.length);
        if (end < text.length &&
            isHighSurrogate(text.charCodeAt(end - 1)) &&
            isLowSurrogate(text.charCodeAt(end))) {
            end -= 1;
        }
        yield text.slice(start, end);
        start = end;
    }
}
function toolOutputCallDigest(input) {
    return createHash('sha256')
        .update(input.toolCallId)
        .update('\0')
        .update(input.toolName)
        .digest('hex')
        .slice(0, 24);
}
function imageExtension(mimeType) {
    const subtype = mimeType.toLowerCase().split('/')[1]?.split(/[;+]/u)[0];
    if (subtype === 'jpeg')
        return 'jpg';
    return subtype && /^[a-z0-9]{1,8}$/u.test(subtype) ? subtype : 'bin';
}
function encodeReadableChunk(index, byteOffset, text) {
    return `${JSON.stringify({ type: 'chunk', index, byte_offset: byteOffset, text })}\n`;
}
function sha256Text(text) {
    const hash = createHash('sha256');
    for (const chunk of boundedTextChunks(text))
        hash.update(chunk);
    return hash.digest('hex');
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
//# sourceMappingURL=tool-output-artifact-format.js.map