import { decodeRuntimeTransportWirePayload, encodeRuntimeTransportWirePayload, isRuntimeTransportClientFrame, isRuntimeTransportServerFrame, } from '../runtime-transport/index.js';
export function encodeAppServerDesktopServiceClientFrame(frame) {
    if (!isRuntimeTransportClientFrame(frame)) {
        throw new TypeError('Cannot encode an invalid Runtime transport client frame.');
    }
    if (frame.type === 'request' && frame.body instanceof Uint8Array) {
        return { ...frame, body: encodeRuntimeTransportWirePayload(frame.body) };
    }
    return { ...frame };
}
export function encodeAppServerDesktopServiceServerFrame(frame) {
    if (!isRuntimeTransportServerFrame(frame)) {
        throw new TypeError('Cannot encode an invalid Runtime transport server frame.');
    }
    if (frame.type === 'stream-chunk') {
        return { ...frame, payload: encodeRuntimeTransportWirePayload(frame.payload) };
    }
    return { ...frame };
}
export function decodeAppServerDesktopServiceClientFrame(value) {
    if (!isRecord(value))
        return invalidClientFrame('DesktopService frame must be an object.');
    if (value.type === 'request') {
        const bodyResult = decodeOptionalWirePayload(value.body, 'body');
        if (!bodyResult.ok)
            return bodyResult;
        const candidate = { ...value };
        if (bodyResult.value === undefined)
            delete candidate.body;
        else
            candidate.body = bodyResult.value;
        if (!isRuntimeTransportClientFrame(candidate)) {
            return invalidClientFrame('DesktopService request frame must contain a valid id, method, url, and headers.');
        }
        return { ok: true, frame: candidate };
    }
    if (value.type === 'stream-credit' || value.type === 'abort') {
        if (!isRuntimeTransportClientFrame(value)) {
            return invalidClientFrame(`Invalid DesktopService ${String(value.type)} frame.`);
        }
        return { ok: true, frame: value };
    }
    return invalidClientFrame('DesktopService frame type must be request, stream-credit, or abort.');
}
export function decodeAppServerDesktopServiceServerFrame(value) {
    if (!isRecord(value))
        return invalidServerFrame('DesktopService frame must be an object.');
    if (value.type === 'stream-chunk') {
        const payloadResult = decodeRequiredWirePayload(value.payload, 'payload');
        if (!payloadResult.ok)
            return payloadResult;
        const candidate = { ...value, payload: payloadResult.value };
        if (!isRuntimeTransportServerFrame(candidate)) {
            return invalidServerFrame('Invalid DesktopService stream-chunk frame.');
        }
        return { ok: true, frame: candidate };
    }
    if (!isRuntimeTransportServerFrame(value)) {
        return invalidServerFrame('Invalid DesktopService response frame.');
    }
    return { ok: true, frame: value };
}
function decodeRequiredWirePayload(value, fieldName) {
    const result = decodeOptionalWirePayload(value, fieldName);
    if (!result.ok)
        return result;
    return result.value === undefined
        ? { ok: false, message: `DesktopService ${fieldName} is required.` }
        : { ok: true, value: result.value };
}
function decodeOptionalWirePayload(value, fieldName) {
    if (value === undefined || value instanceof Uint8Array) {
        return { ok: true, value };
    }
    const decoded = decodeRuntimeTransportWirePayload(value);
    if (decoded.ok)
        return { ok: true, value: decoded.value };
    return decoded.reason === 'invalidBase64'
        ? { ok: false, message: `DesktopService ${fieldName} contains invalid base64.` }
        : { ok: false, message: `DesktopService ${fieldName} must be text or a base64 payload.` };
}
function invalidClientFrame(message) {
    return { ok: false, message };
}
function invalidServerFrame(message) {
    return { ok: false, message };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=index.js.map