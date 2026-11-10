import { httpServiceContextFromHeaders } from '@mavis/thrift-gen/runtime';
export function buildRequestContext(request, deps) {
    const base = httpServiceContextFromHeaders(request.headers);
    const requestId = deps.newRequestId();
    return {
        ...base,
        traceId: base.traceId ?? requestId,
        signal: request.signal,
        logger: deps.logger,
        requestId,
        startedAtMs: deps.nowMs(),
        requestHeaders: new Headers(request.headers),
        observationHeaders: new Headers(),
    };
}
//# sourceMappingURL=context.js.map