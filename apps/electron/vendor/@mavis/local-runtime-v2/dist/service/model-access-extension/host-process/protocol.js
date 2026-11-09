import { MODEL_ACCESS_HOST_PROTOCOL, } from './contracts.js';
import { StringDecoder } from 'node:string_decoder';
export const MODEL_ACCESS_HOST_MAX_LINE_BYTES = 32 * 1024 * 1024;
export const MODEL_ACCESS_HOST_MAX_PENDING_REQUESTS = 128;
export class ModelAccessHostProtocolError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessHostProtocolError';
    }
}
export function encodeHostMessage(message, maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
    const encoded = JSON.stringify(message);
    if (typeof encoded !== 'string')
        throw new ModelAccessHostProtocolError('protocol_encode');
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > maxLineBytes)
        throw new ModelAccessHostProtocolError('protocol_line_too_large');
    return `${encoded}\n`;
}
/** @internal Exported for focused tests. */
export function decodeHostMessage(line, maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
    if (!line || Buffer.byteLength(line, 'utf8') > maxLineBytes)
        throw new ModelAccessHostProtocolError('protocol_line_too_large');
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new ModelAccessHostProtocolError('protocol_json');
    }
    validateMessage(value);
    return value;
}
function validateEnvelope(value) {
    if (!isRecord(value) || value.version !== MODEL_ACCESS_HOST_PROTOCOL)
        throw new ModelAccessHostProtocolError('protocol_version');
    if (typeof value.type !== 'string' || typeof value.epoch !== 'string')
        throw new ModelAccessHostProtocolError('protocol_envelope');
}
function validateMessage(value) {
    validateEnvelope(value);
    switch (value.type) {
        case 'request':
            return validateRequest(value);
        case 'cancel':
            return validateCancel(value);
        case 'response':
            return validateResponse(value);
        case 'event':
            return validateEvent(value);
        case 'stream':
            return validateStream(value);
        case 'credit':
            return validateCredit(value);
        case 'flow':
            return validateFlow(value);
        default:
            throw new ModelAccessHostProtocolError('protocol_type');
    }
}
function validateRequest(value) {
    if (typeof value.id !== 'string' ||
        !value.id ||
        typeof value.method !== 'string' ||
        !isHostMethod(value.method) ||
        !Object.hasOwn(value, 'params') ||
        (value.slot !== undefined && !validSlot(value.slot)))
        throw new ModelAccessHostProtocolError('protocol_request');
}
function validateCancel(value) {
    if (typeof value.id !== 'string' || !value.id)
        throw new ModelAccessHostProtocolError('protocol_cancel');
}
function validateResponse(value) {
    if (typeof value.id !== 'string' || !value.id || !validResponseShape(value))
        throw new ModelAccessHostProtocolError('protocol_response');
}
function validateEvent(value) {
    if (!['hello', 'ready', 'fatal'].includes(String(value.event)))
        throw new ModelAccessHostProtocolError('protocol_event');
    if (value.error !== undefined && !validError(value.error))
        throw new ModelAccessHostProtocolError('protocol_error');
    if (value.slot !== undefined && (value.event !== 'fatal' || !validSlot(value.slot)))
        throw new ModelAccessHostProtocolError('protocol_event');
}
function validateStream(value) {
    if (typeof value.id !== 'string' ||
        !value.id ||
        !['head', 'chunk', 'end', 'error'].includes(String(value.event)))
        throw new ModelAccessHostProtocolError('protocol_stream');
    validateStreamPayload(value);
}
function validateStreamPayload(value) {
    if (value.event === 'chunk' && typeof value.data !== 'string')
        throw new ModelAccessHostProtocolError('protocol_stream_chunk');
    if (value.event === 'head' && (typeof value.status !== 'number' || !isHeaderMap(value.headers)))
        throw new ModelAccessHostProtocolError('protocol_stream_head');
    if (value.event === 'error' && !validError(value.error))
        throw new ModelAccessHostProtocolError('protocol_stream_error');
}
function validateCredit(value) {
    if (typeof value.id !== 'string' ||
        !value.id ||
        typeof value.n !== 'number' ||
        !Number.isSafeInteger(value.n) ||
        value.n <= 0)
        throw new ModelAccessHostProtocolError('protocol_credit');
}
function validateFlow(value) {
    if (typeof value.flowRef !== 'string' ||
        value.flowRef.length < 1 ||
        value.flowRef.length > 256 ||
        !Number.isSafeInteger(value.seq) ||
        Number(value.seq) < 1 ||
        !['view', 'result'].includes(String(value.event)))
        throw new ModelAccessHostProtocolError('protocol_flow');
    validateFlowPayload(value);
}
function validateFlowPayload(value) {
    if (value.event === 'view' && !isRecord(value.view))
        throw new ModelAccessHostProtocolError('protocol_flow_view');
    if (value.event === 'result' && value.view !== undefined)
        throw new ModelAccessHostProtocolError('protocol_flow_result');
    if (Object.keys(value).some((key) => !['type', 'version', 'epoch', 'flowRef', 'seq', 'event', 'view'].includes(key)))
        throw new ModelAccessHostProtocolError('protocol_flow');
}
export class HostLineDecoder {
    maxLineBytes;
    buffer = Buffer.alloc(0);
    utf8 = new StringDecoder('utf8');
    constructor(maxLineBytes = MODEL_ACCESS_HOST_MAX_LINE_BYTES) {
        this.maxLineBytes = maxLineBytes;
    }
    get limit() {
        return this.maxLineBytes;
    }
    push(chunk) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
        this.buffer = Buffer.concat([this.buffer, bytes]);
        if (this.buffer.length > this.maxLineBytes && !this.buffer.includes(0x0a))
            throw new ModelAccessHostProtocolError('protocol_line_too_large');
        const messages = [];
        let newline;
        while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
            let lineBytes = this.buffer.subarray(0, newline);
            if (lineBytes.at(-1) === 0x0d)
                lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
            const line = this.utf8.write(lineBytes);
            this.buffer = this.buffer.subarray(newline + 1);
            messages.push(decodeHostMessage(line, this.maxLineBytes));
        }
        if (this.buffer.length > this.maxLineBytes)
            throw new ModelAccessHostProtocolError('protocol_line_too_large');
        return messages;
    }
    finish() {
        const tail = `${this.utf8.end()}${this.buffer.toString('utf8')}`;
        this.buffer = Buffer.alloc(0);
        if (tail.trim())
            throw new ModelAccessHostProtocolError('protocol_truncated');
    }
}
export function hostError(code, ref) {
    const safeCode = /^[a-z][a-z0-9_.-]{0,95}$/u.test(code) ? code : 'host_failed';
    return ref && /^[a-f0-9-]{16,128}$/u.test(ref) ? { code: safeCode, ref } : { code: safeCode };
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isHostMethod(value) {
    return [
        'init',
        'describe',
        'models',
        'usage',
        'borrow.discover',
        'apiKeyScan.scan',
        'resolveOwned',
        'renewOwned',
        'forceRenewOwned',
        'forget',
        'borrow.resolve',
        'borrow.renew',
        'borrow.forceRenew',
        'bindTransport',
        'fetch',
        'body.begin',
        'body.chunk',
        'body.end',
        'body.discard',
        'disposeTransport',
        'classifyError',
        'login.begin',
        'login.submit',
        'login.result',
        'login.cancel',
        'drain',
        'shutdown',
        'unload',
    ].includes(value);
}
function validSlot(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function validError(value) {
    return (isRecord(value) &&
        typeof value.code === 'string' &&
        /^[a-z][a-z0-9_.-]{0,95}$/u.test(value.code) &&
        (value.ref === undefined ||
            (typeof value.ref === 'string' && /^[a-f0-9-]{16,128}$/u.test(value.ref))));
}
function validResponseShape(value) {
    const hasResult = Object.hasOwn(value, 'result');
    const hasError = Object.hasOwn(value, 'error');
    return hasResult !== hasError && (!hasError || validError(value.error));
}
function isHeaderMap(value) {
    if (!isRecord(value) || Object.keys(value).length > 256)
        return false;
    return Object.entries(value).every(([key, entry]) => key.length <= 1024 && typeof entry === 'string' && entry.length <= 16 * 1024);
}
//# sourceMappingURL=protocol.js.map