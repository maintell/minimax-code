import { APP_SERVER_ERROR_CODES, DEFAULT_APP_SERVER_MAX_MESSAGE_BYTES } from './constants.js';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
/**
 * The renderer bundles this package, so the wire codec stays on Web-standard
 * APIs instead of `node:buffer`.
 */
function encodeBase64(bytes) {
    let out = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const byte0 = bytes[index];
        const byte1 = bytes[index + 1];
        const byte2 = bytes[index + 2];
        out += BASE64_ALPHABET[byte0 >> 2];
        out += BASE64_ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
        out += byte1 === undefined ? '=' : BASE64_ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
        out += byte2 === undefined ? '=' : BASE64_ALPHABET[byte2 & 0x3f];
    }
    return out;
}
export function parseAppServerMessage(input, options = {}) {
    const text = typeof input === 'string' ? input : utf8Decoder.decode(input);
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_APP_SERVER_MAX_MESSAGE_BYTES;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
        return {
            ok: false,
            error: {
                code: APP_SERVER_ERROR_CODES.invalidRequest,
                message: 'The app-server message limit must be a positive safe integer.',
            },
        };
    }
    const sizeBytes = utf8Encoder.encode(text).length;
    if (sizeBytes > maxMessageBytes) {
        return {
            ok: false,
            error: {
                code: APP_SERVER_ERROR_CODES.invalidRequest,
                message: `Message exceeds the ${maxMessageBytes}-byte app-server limit.`,
                data: { sizeBytes, maxMessageBytes },
            },
        };
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return {
            ok: false,
            error: { code: APP_SERVER_ERROR_CODES.parseError, message: 'Invalid JSON.' },
        };
    }
    return validateAppServerMessage(value);
}
export function serializeAppServerMessage(message) {
    return `${JSON.stringify(toJsonSafe(message))}\n`;
}
export function makeAppServerError(code, message, data) {
    return data === undefined ? { code, message } : { code, message, data: toJsonSafe(data) };
}
export function makeErrorResponse(id, error) {
    return { id, error };
}
export function makeResultResponse(id, result) {
    return { id, result: toJsonSafe(result) };
}
export function isAppServerRequest(message) {
    return 'id' in message && 'method' in message;
}
export function isAppServerNotification(message) {
    return 'method' in message && !('id' in message);
}
export function isAppServerResponse(message) {
    return 'id' in message && !('method' in message);
}
export function toJsonSafe(value, seen = new WeakSet()) {
    if (typeof value === 'bigint')
        return value.toString();
    if (value === null || typeof value !== 'object')
        return value;
    if (seen.has(value))
        return '[Circular]';
    seen.add(value);
    try {
        if (Array.isArray(value))
            return value.map((item) => toJsonSafe(item, seen));
        if (value instanceof Uint8Array)
            return encodeBase64(value);
        const result = {};
        for (const [key, item] of Object.entries(value))
            result[key] = toJsonSafe(item, seen);
        return result;
    }
    finally {
        seen.delete(value);
    }
}
function validateAppServerMessage(value) {
    if (!isRecord(value))
        return invalidRequest('Message must be a JSON object.');
    if (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') {
        return invalidRequest('Only JSON-RPC 2.0 messages are supported.');
    }
    const method = value.method;
    if (typeof method === 'string' && method.trim().length > 0) {
        if (value.params !== undefined && !isRecord(value.params)) {
            return invalidParams('Request params must be an object.');
        }
        if (value.id === undefined) {
            return {
                ok: true,
                message: { method, ...(value.params ? { params: value.params } : {}) },
            };
        }
        if (!isValidId(value.id))
            return invalidRequest('Request id must be a string or number.');
        return {
            ok: true,
            message: { id: value.id, method, ...(value.params ? { params: value.params } : {}) },
        };
    }
    if (value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
        if (!isValidId(value.id) && value.id !== null) {
            return invalidRequest('Response id must be a string, number, or null.');
        }
        if (value.result !== undefined && value.error !== undefined) {
            return invalidRequest('Response cannot contain both result and error.');
        }
        if (value.error !== undefined) {
            if (!isRecord(value.error) || typeof value.error.code !== 'number') {
                return invalidRequest('Response error must contain a numeric code.');
            }
            return {
                ok: true,
                message: {
                    id: value.id,
                    error: {
                        code: value.error.code,
                        message: typeof value.error.message === 'string' ? value.error.message : 'Remote error.',
                        ...(value.error.data !== undefined ? { data: value.error.data } : {}),
                    },
                },
            };
        }
        return {
            ok: true,
            message: { id: value.id, result: value.result },
        };
    }
    return invalidRequest('Message must be a request, notification, or response.');
}
function invalidRequest(message) {
    return { ok: false, error: makeAppServerError(APP_SERVER_ERROR_CODES.invalidRequest, message) };
}
function invalidParams(message) {
    return { ok: false, error: makeAppServerError(APP_SERVER_ERROR_CODES.invalidParams, message) };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isValidId(value) {
    return ((typeof value === 'string' && value.length > 0) ||
        (typeof value === 'number' && Number.isFinite(value)));
}
//# sourceMappingURL=wire.js.map