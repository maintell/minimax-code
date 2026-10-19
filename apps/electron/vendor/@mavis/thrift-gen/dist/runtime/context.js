export const HTTP_SERVICE_TRACE_ID_HEADER = 'X-Trace-Id';
export const HTTP_SERVICE_TRACE_ID_RESPONSE_HEADER = 'Trace-Id';
export const HTTP_SERVICE_USER_ID_HEADER = 'X-Archon-User-Id';
export const HTTP_SERVICE_BIZ_ID_HEADER = 'x-archon-biz-id';
export function headersFromHttpServiceContext(ctx) {
    const headers = new Headers(ctx?.headers);
    if (ctx?.traceId && !headers.has(HTTP_SERVICE_TRACE_ID_HEADER)) {
        headers.set(HTTP_SERVICE_TRACE_ID_HEADER, ctx.traceId);
    }
    if (ctx?.userId && !headers.has(HTTP_SERVICE_USER_ID_HEADER)) {
        headers.set(HTTP_SERVICE_USER_ID_HEADER, ctx.userId);
    }
    if (ctx?.bizId && !headers.has(HTTP_SERVICE_BIZ_ID_HEADER)) {
        headers.set(HTTP_SERVICE_BIZ_ID_HEADER, ctx.bizId);
    }
    return headers;
}
export function httpServiceContextFromHeaders(headers, signal) {
    const ctx = {};
    const traceId = headers.get(HTTP_SERVICE_TRACE_ID_HEADER);
    const userId = headers.get(HTTP_SERVICE_USER_ID_HEADER);
    const bizId = headers.get(HTTP_SERVICE_BIZ_ID_HEADER);
    if (traceId)
        ctx.traceId = traceId;
    if (userId)
        ctx.userId = userId;
    if (bizId)
        ctx.bizId = bizId;
    if (signal)
        ctx.signal = signal;
    return ctx;
}
export function responseHeadersFromHttpServiceContext(ctx, init) {
    const headers = new Headers(init);
    if (ctx.traceId && !headers.has(HTTP_SERVICE_TRACE_ID_RESPONSE_HEADER)) {
        headers.set(HTTP_SERVICE_TRACE_ID_RESPONSE_HEADER, ctx.traceId);
    }
    return headers;
}
export const RPC_TRACE_ID_HEADER = HTTP_SERVICE_TRACE_ID_HEADER;
export const RPC_TRACE_ID_RESPONSE_HEADER = HTTP_SERVICE_TRACE_ID_RESPONSE_HEADER;
export const RPC_USER_ID_HEADER = HTTP_SERVICE_USER_ID_HEADER;
export const RPC_BIZ_ID_HEADER = HTTP_SERVICE_BIZ_ID_HEADER;
export const headersFromRpcContext = headersFromHttpServiceContext;
export const rpcContextFromHeaders = httpServiceContextFromHeaders;
export const responseHeadersFromRpcContext = responseHeadersFromHttpServiceContext;
//# sourceMappingURL=context.js.map