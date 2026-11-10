import { REQUEST_BODY_MAX_BYTES, REQUEST_BODY_GLOBAL_BYTES, REQUEST_BODY_CHUNK_BYTES, REQUEST_BODY_TIMEOUT_MS, requestBodyError, } from '../rpc/request-body.js';
export class HostRequestBodies {
    hasTransport;
    limits;
    bodies = new Map();
    reserved = 0;
    constructor(hasTransport, limits = {
        maxBytes: REQUEST_BODY_MAX_BYTES,
        globalBytes: REQUEST_BODY_GLOBAL_BYTES,
        timeoutMs: REQUEST_BODY_TIMEOUT_MS,
    }) {
        this.hasTransport = hasTransport;
        this.limits = limits;
    }
    dispatch(method, value) {
        const { input, ref, transportRef } = bodyInput(value);
        if (method === 'body.discard') {
            if (this.bodies.get(ref)?.transportRef === transportRef)
                this.release(ref);
            return null;
        }
        if (!this.hasTransport(transportRef))
            throw requestBodyError('host_transport_missing');
        if (method === 'body.begin') {
            this.begin(ref, transportRef, input.maxBytes);
            return null;
        }
        const body = this.bodies.get(ref);
        if (!body || body.transportRef !== transportRef || body.ended)
            throw requestBodyError('request_body_invalid');
        try {
            this.append(method, input, body);
            return null;
        }
        catch (error) {
            this.release(ref);
            throw error;
        }
    }
    begin(ref, transportRef, capacity) {
        if (!Number.isSafeInteger(capacity) ||
            typeof capacity !== 'number' ||
            capacity < 1 ||
            capacity > this.limits.maxBytes)
            throw requestBodyError('request_body_too_large');
        if (this.bodies.has(ref))
            throw requestBodyError('request_body_invalid');
        if (this.reserved + capacity > this.limits.globalBytes)
            throw requestBodyError('request_body_busy');
        const buffer = Buffer.alloc(capacity);
        const timer = setTimeout(() => this.release(ref), this.limits.timeoutMs);
        timer.unref?.();
        this.bodies.set(ref, {
            transportRef,
            buffer,
            bytes: 0,
            sequence: 0,
            ended: false,
            taken: false,
            timer,
        });
        this.reserved += capacity;
    }
    append(method, input, body) {
        if (input.sequence !== body.sequence)
            throw requestBodyError('request_body_sequence');
        if (method === 'body.chunk') {
            const chunk = decodeChunk(input.data);
            if (chunk.length > REQUEST_BODY_CHUNK_BYTES || body.bytes + chunk.length > body.buffer.length)
                throw requestBodyError('request_body_too_large');
            chunk.copy(body.buffer, body.bytes);
            body.bytes += chunk.length;
            body.sequence++;
        }
        else if (method === 'body.end') {
            if (input.bytes !== body.bytes)
                throw requestBodyError('request_body_invalid');
            body.ended = true;
        }
        else
            throw requestBodyError('request_body_invalid');
    }
    take(ref, transportRef) {
        const body = this.bodies.get(ref);
        if (!body || body.transportRef !== transportRef || !body.ended || body.taken)
            throw requestBodyError('request_body_invalid');
        body.taken = true;
        clearTimeout(body.timer);
        return body.buffer.subarray(0, body.bytes);
    }
    release(ref, transportRef) {
        const body = this.bodies.get(ref);
        if (!body || body.taken || (transportRef !== undefined && body.transportRef !== transportRef))
            return;
        clearTimeout(body.timer);
        this.reserved -= body.buffer.length;
        this.bodies.delete(ref);
    }
    complete(ref, transportRef) {
        const body = this.bodies.get(ref);
        if (!body || body.transportRef !== transportRef)
            return;
        body.taken = false;
        this.release(ref, transportRef);
    }
    disposeTransport(transportRef) {
        for (const [ref, body] of this.bodies)
            if (body.transportRef === transportRef)
                this.release(ref);
    }
    clear() {
        for (const ref of this.bodies.keys())
            this.release(ref);
    }
}
function bodyInput(value) {
    if (!value || typeof value !== 'object')
        throw requestBodyError('request_body_invalid');
    const input = value;
    const { ref, transportRef } = input;
    if (typeof ref !== 'string' || !/^[a-f0-9-]{36}$/u.test(ref) || typeof transportRef !== 'string')
        throw requestBodyError('request_body_invalid');
    return { input, ref, transportRef };
}
function decodeChunk(data) {
    if (typeof data !== 'string' ||
        data.length > Math.ceil(REQUEST_BODY_CHUNK_BYTES / 3) * 4 ||
        data.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/u.test(data))
        throw requestBodyError('request_body_invalid');
    const chunk = Buffer.from(data, 'base64');
    if (chunk.toString('base64') !== data)
        throw requestBodyError('request_body_invalid');
    return chunk;
}
//# sourceMappingURL=request-bodies.js.map