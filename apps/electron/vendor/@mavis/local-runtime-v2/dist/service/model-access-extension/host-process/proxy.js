import { MODEL_ACCESS_HOST_DEFAULT_WINDOW } from './stream.js';
import { serializeHostFailure } from './failure-codec.js';
import { uploadRequestBody, discardRequestBody, requestBodyError, REQUEST_BODY_TIMEOUT_MS, } from './rpc/request-body.js';
/** Host-side classifier adapter. The provider's synchronous SDK method remains child-local. */
export function createModelAccessHostClassifier(peer, providerId, options = {}) {
    const cache = new WeakMap();
    return (error, control = {}) => {
        const key = isObject(error) ? error : undefined;
        const cached = key ? cache.get(key) : undefined;
        if (cached)
            return cached;
        const request = classify(peer.request('classifyError', { providerId, error: serializeHostFailure(error) }, { signal: control.signal, timeoutMs: options.timeoutMs }));
        if (key)
            cache.set(key, request);
        return request;
    };
}
async function classify(result) {
    return validateClassifiedAccessError(await result);
}
/** Restores the SDK transport shape while keeping the actual fetch in the child. */
export function createModelAccessHostTransport(peer, metadata, options = {}) {
    let disposed = false;
    const disposal = new AbortController();
    const transport = {
        api: metadata.api,
        modelId: metadata.modelId,
        baseUrl: metadata.baseUrl,
        ...(metadata.apiKey === undefined ? {} : { apiKey: metadata.apiKey }),
        ...(metadata.headers === undefined ? {} : { headers: metadata.headers }),
        fetch: async (input, init) => {
            if (disposed)
                throw new Error('host_transport_disposed');
            const request = serializeFetch(input, init);
            const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const signal = AbortSignal.any([disposal.signal, ...(callerSignal ? [callerSignal] : [])]);
            let body;
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(requestBodyError('request_body_timeout')), options.bodyTimeoutMs ?? REQUEST_BODY_TIMEOUT_MS);
            try {
                if (request.body)
                    body = await uploadRequestBody(peer, metadata.transportRef, request.body, {
                        signal: AbortSignal.any([signal, deadline.signal]),
                        maxBytes: options.maxBodyBytes,
                    });
            }
            finally {
                clearTimeout(timer);
            }
            try {
                return await peer.requestStream('fetch', {
                    transportRef: metadata.transportRef,
                    input: request.input,
                    init: { ...request.init, ...(body ? { body } : {}) },
                    window: options.window ?? MODEL_ACCESS_HOST_DEFAULT_WINDOW,
                }, { signal });
            }
            catch (error) {
                await discardRequestBody(peer, metadata.transportRef, body?.ref);
                throw error;
            }
        },
        dispose: async () => {
            if (disposed)
                return;
            disposed = true;
            disposal.abort();
            await peer.request('disposeTransport', { transportRef: metadata.transportRef });
        },
    };
    return Object.freeze(transport);
}
function serializeFetch(input, init) {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const headers = new Headers(request?.headers);
    if (init?.headers)
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const bodyResponse = init?.body != null ? new Response(init.body) : undefined;
    const body = bodyResponse?.body ?? request?.body ?? undefined;
    const contentType = bodyResponse?.headers.get('content-type');
    if (contentType && !headers.has('content-type'))
        headers.set('content-type', contentType);
    return {
        input: url,
        body,
        init: {
            method: init?.method ?? request?.method,
            headers: headerRecord(headers),
        },
    };
}
function headerRecord(headers) {
    const result = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}
function validateClassifiedAccessError(value) {
    if (!isObject(value) ||
        ![
            'credential',
            'identity',
            'quota',
            'rate-limit',
            'model',
            'request',
            'refusal',
            'dependency',
            'platform',
            'network',
        ].includes(value.category) ||
        typeof value.code !== 'string' ||
        !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value.code) ||
        typeof value.retryable !== 'boolean' ||
        (value.retryAfterMs !== undefined &&
            (typeof value.retryAfterMs !== 'number' ||
                !Number.isFinite(value.retryAfterMs) ||
                value.retryAfterMs < 0))) {
        throw new Error('host_classification_invalid');
    }
    return value;
}
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=proxy.js.map