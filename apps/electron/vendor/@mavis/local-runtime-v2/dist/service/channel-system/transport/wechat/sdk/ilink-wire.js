const ILINK_CHANNEL_VERSION = '2.4.6';
const ILINK_APP_ID = 'bot';
const ILINK_BOT_AGENT = `Mavis/${ILINK_CHANNEL_VERSION}`;
const ILINK_APP_CLIENT_VERSION = encodeIlinkClientVersion(ILINK_CHANNEL_VERSION);
function encodeIlinkClientVersion(version) {
    const [major = 0, minor = 0, patch = 0] = version
        .split('.')
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
export function buildIlinkCommonHeaders() {
    return {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
}
export function buildIlinkBaseInfo() {
    return {
        channel_version: ILINK_CHANNEL_VERSION,
        bot_agent: ILINK_BOT_AGENT,
    };
}
/**
 * iLink Bot SDK — lossless JSON parsing for 64-bit message identifiers.
 *
 * WeChat message ids are uint64 (`7529089277818356123`), far past
 * `Number.MAX_SAFE_INTEGER`. `JSON.parse` rounds them to the nearest double —
 * `7529089277818356000` — so every id read off the wire used to be wrong, and
 * dedupe / correlation keyed on such an id matches a message that never
 * existed. We therefore quote those integer literals as strings BEFORE
 * `JSON.parse` sees them, exactly as the official
 * `@tencent-weixin/openclaw-weixin` SDK does.
 *
 * Two deliberate limits:
 *   - only the three id keys below are rewritten, so `ret`, `errcode`, `seq`,
 *     `create_time_ms` and every size stay numbers;
 *   - only real object properties with a bare integer-literal value are
 *     rewritten, so a `"message_id":123` sequence that merely appears inside a
 *     JSON string (a user pasting JSON into a chat) is left untouched.
 */
/** Keys whose integer values must survive as exact strings. */
const LOSSLESS_ID_KEYS = new Set(['message_id', 'msg_id', 'svr_id']);
/**
 * Parse one iLink response, keeping 64-bit ids exact. Behaves like
 * `JSON.parse` otherwise, including throwing on malformed input.
 */
export function parseIlinkJson(rawText) {
    let output = '';
    let index = 0;
    while (index < rawText.length) {
        if (rawText[index] !== '"') {
            output += rawText[index];
            index += 1;
            continue;
        }
        const token = readStringToken(rawText, index);
        output += token.text;
        index = token.next;
        // A key is a string token followed by `:`.
        const colon = findColon(rawText, index);
        if (colon < 0)
            continue;
        const key = readJsonString(token.text);
        if (key === undefined || !LOSSLESS_ID_KEYS.has(key))
            continue;
        // Keep the `:` and its surrounding whitespace verbatim, then decide on
        // the value.
        output += rawText.slice(index, colon + 1);
        let cursor = colon + 1;
        while (isWhitespace(rawText[cursor])) {
            output += rawText[cursor];
            cursor += 1;
        }
        const literal = readIntegerLiteral(rawText, cursor);
        if (!literal) {
            // Not an integer (`"123"`, `null`, `1.5`): re-scan from the value so
            // the main loop copies it through unchanged.
            index = cursor;
            continue;
        }
        output += `"${literal.text}"`;
        index = literal.next;
    }
    return JSON.parse(output);
}
/** One complete JSON string token, escapes included, starting at the quote. */
function readStringToken(rawText, start) {
    let index = start + 1;
    let escaped = false;
    while (index < rawText.length) {
        const char = rawText[index];
        index += 1;
        if (escaped)
            escaped = false;
        else if (char === '\\')
            escaped = true;
        else if (char === '"')
            break;
    }
    return { text: rawText.slice(start, index), next: index };
}
/** Index of the `:` following a string token, or -1 when it is not a key. */
function findColon(rawText, afterToken) {
    let cursor = afterToken;
    while (isWhitespace(rawText[cursor]))
        cursor += 1;
    return rawText[cursor] === ':' ? cursor : -1;
}
/**
 * A bare integer literal at `start`, or `undefined` for anything else.
 * A float / exponent (`1.5`, `1e3`) is rejected rather than half-quoted,
 * which would corrupt the document.
 */
function readIntegerLiteral(rawText, start) {
    let cursor = start;
    if (rawText[cursor] === '-')
        cursor += 1;
    const digitsStart = cursor;
    while (isDigit(rawText[cursor]))
        cursor += 1;
    if (cursor === digitsStart || isNumberContinuation(rawText[cursor]))
        return undefined;
    return { text: rawText.slice(start, cursor), next: cursor };
}
function isWhitespace(char) {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
function isDigit(char) {
    return char !== undefined && char >= '0' && char <= '9';
}
/** A character that turns the digits just read into a float / exponent. */
function isNumberContinuation(char) {
    return char === '.' || char === 'e' || char === 'E';
}
function readJsonString(token) {
    try {
        const value = JSON.parse(token);
        return typeof value === 'string' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=ilink-wire.js.map