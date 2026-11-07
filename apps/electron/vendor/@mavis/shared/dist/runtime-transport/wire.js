/** Encode an internal structured-clone payload for a JSON wire. */
export function encodeRuntimeTransportWirePayload(payload) {
    if (typeof payload === 'string')
        return payload;
    return {
        encoding: 'base64',
        data: Buffer.from(payload).toString('base64'),
    };
}
/** Decode and validate one untrusted JSON wire payload. */
export function decodeRuntimeTransportWirePayload(value) {
    if (typeof value === 'string')
        return { ok: true, value };
    if (!isRecord(value) || value.encoding !== 'base64' || typeof value.data !== 'string') {
        return { ok: false, reason: 'invalidType' };
    }
    if (!isCanonicalBase64(value.data))
        return { ok: false, reason: 'invalidBase64' };
    return { ok: true, value: Uint8Array.from(Buffer.from(value.data, 'base64')) };
}
function isCanonicalBase64(value) {
    if (value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        return false;
    }
    return Buffer.from(value, 'base64').toString('base64') === value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=wire.js.map