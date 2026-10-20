/**
 * Optional binary framing for the app-server stdio stream.
 *
 * The baseline wire is newline-delimited JSON, so every binary payload has to
 * travel as base64 inside a JSON string and pays a fixed 33% expansion. On a
 * bandwidth-capped SSH link that expansion is the single largest avoidable
 * cost of reading a remote file.
 *
 * A binary frame keeps the JSON envelope for metadata but moves the bytes out
 * of the JSON document:
 *
 * ```text
 * \x1E{"type":"stream-chunk","id":"r7","seq":3,"byteLength":786432}\n<786432 raw bytes>
 * ```
 *
 * `\x1E` (ASCII record separator) cannot begin a JSON value, so a reader can
 * tell the two framings apart from the first byte and both may be interleaved
 * on one stream. The header is JSON so it stays extensible.
 *
 * This framing is only used after both peers advertise it during `initialize`;
 * see `binaryPayloadEncoding` in `APP_SERVER_DESKTOP_SERVICE_CAPABILITIES`.
 * Anything that has not negotiated it keeps emitting base64 JSON, so an older
 * remote CLI is unaffected.
 */
/** First byte of a binary frame. Never a legal first byte of a JSON message. */
export const APP_SERVER_BINARY_FRAME_PREFIX = 0x1e;
/** Payload encodings this build can decode, best first. */
export const APP_SERVER_BINARY_PAYLOAD_ENCODINGS = ['binaryFrame', 'base64'];
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
/**
 * Pick the payload encoding to use for a peer.
 *
 * Selection is intentionally conservative: an encoding is only chosen when the
 * peer names it explicitly, so a missing, malformed or unknown value always
 * degrades to base64 rather than corrupting the stream.
 */
export function negotiateAppServerBinaryPayloadEncoding(peerEncodings) {
    const offered = new Set(Array.isArray(peerEncodings) ? peerEncodings.filter((v) => typeof v === 'string') : []);
    for (const candidate of APP_SERVER_BINARY_PAYLOAD_ENCODINGS) {
        if (offered.has(candidate))
            return candidate;
    }
    return 'base64';
}
/** Serialize one binary frame. `header.byteLength` is set from `bytes`. */
export function encodeAppServerBinaryFrame(header, bytes) {
    const headerJson = JSON.stringify({ ...header, byteLength: bytes.byteLength });
    const headerBytes = utf8Encoder.encode(headerJson);
    const out = new Uint8Array(1 + headerBytes.byteLength + 1 + bytes.byteLength);
    out[0] = APP_SERVER_BINARY_FRAME_PREFIX;
    out.set(headerBytes, 1);
    out[1 + headerBytes.byteLength] = 0x0a;
    out.set(bytes, 1 + headerBytes.byteLength + 1);
    return out;
}
/**
 * Try to read one binary frame from the front of `buffer`.
 *
 * The caller is responsible for having checked that `buffer[0]` is
 * `APP_SERVER_BINARY_FRAME_PREFIX`. `consumed` is the number of bytes to drop
 * from the front once a frame is returned.
 *
 * `maxHeaderBytes` bounds how far this scans for the header terminator so a
 * peer cannot force unbounded buffering by never sending a newline.
 */
export function readAppServerBinaryFrame(buffer, options = {}) {
    if (buffer.byteLength === 0)
        return { status: 'incomplete' };
    if (buffer[0] !== APP_SERVER_BINARY_FRAME_PREFIX) {
        return { status: 'invalid', reason: 'Frame does not start with the binary prefix.' };
    }
    const maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024;
    const newline = indexOfByte(buffer, 0x0a, 1);
    if (newline < 0) {
        return buffer.byteLength > maxHeaderBytes + 1
            ? { status: 'invalid', reason: 'Binary frame header exceeds the size limit.' }
            : { status: 'incomplete' };
    }
    if (newline - 1 > maxHeaderBytes) {
        return { status: 'invalid', reason: 'Binary frame header exceeds the size limit.' };
    }
    let header;
    try {
        header = JSON.parse(utf8Decoder.decode(buffer.subarray(1, newline)));
    }
    catch {
        return { status: 'invalid', reason: 'Binary frame header is not valid JSON.' };
    }
    if (typeof header !== 'object' || header === null || Array.isArray(header)) {
        return { status: 'invalid', reason: 'Binary frame header must be a JSON object.' };
    }
    const byteLength = header.byteLength;
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        return { status: 'invalid', reason: 'Binary frame header must carry a byteLength.' };
    }
    if (options.maxPayloadBytes !== undefined && byteLength > options.maxPayloadBytes) {
        return { status: 'invalid', reason: 'Binary frame payload exceeds the size limit.' };
    }
    const payloadStart = newline + 1;
    const consumed = payloadStart + byteLength;
    if (buffer.byteLength < consumed)
        return { status: 'incomplete' };
    return {
        status: 'frame',
        // Copy into a plain Uint8Array: the caller reuses its accumulation buffer,
        // so a view would alias bytes that are about to be overwritten, and a
        // Node Buffer input would otherwise leak its subclass to consumers.
        frame: {
            header: header,
            bytes: new Uint8Array(buffer.subarray(payloadStart, consumed)),
        },
        consumed,
    };
}
function indexOfByte(buffer, byte, from) {
    for (let index = from; index < buffer.byteLength; index += 1) {
        if (buffer[index] === byte)
            return index;
    }
    return -1;
}
//# sourceMappingURL=binary-frame.js.map