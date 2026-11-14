import { callMatrixToolRaw, MATRIX_TOOL_PATHS, MATRIX_WEB_FETCH_TOOL_NAME, } from '@mavis/agent-tools/cloud';
import { LocalMatrixClient } from '../../matrix/index.js';
const SERVER_READ_STATUSES = [
    'non_html',
    'unreachable',
    'empty_content',
    'blocked',
    'invalid_url',
    'quota_exceeded',
    'not_enabled',
    'busy',
    'provider_error',
];
function isServerReadStatus(status) {
    return SERVER_READ_STATUSES.includes(status);
}
/** Insufficient credits, reported by the gateway rather than the reader. */
const INSUFFICIENT_CREDITS_STATUS_CODE = 402;
export class ServerWebFetchReader {
    client;
    matrixLogger;
    constructor(options = {}) {
        const { matrixLogger, ...clientOptions } = options;
        this.client = new LocalMatrixClient(clientOptions);
        this.matrixLogger = matrixLogger;
    }
    async read(ctx, url, signal) {
        const call = await callMatrixToolRaw({
            toolName: MATRIX_WEB_FETCH_TOOL_NAME,
            path: MATRIX_TOOL_PATHS[MATRIX_WEB_FETCH_TOOL_NAME],
            input: { url },
            ctx: { sessionId: ctx.sessionId, turnId: ctx.turnId, matrixLogger: this.matrixLogger },
            archonServer: this.client,
            ...(signal ? { signal } : {}),
        });
        if (!call.ok)
            return readFailure(call.result.details);
        return readPayload(call.response);
    }
}
function readFailure(details) {
    const statusCode = details?.status_code;
    const httpStatus = details?.http_status;
    if (statusCode === INSUFFICIENT_CREDITS_STATUS_CODE ||
        httpStatus === INSUFFICIENT_CREDITS_STATUS_CODE) {
        return { kind: 'quota' };
    }
    return { kind: 'failure' };
}
function readPayload(payload) {
    const status = typeof payload.status === 'string' ? payload.status : '';
    if (status === 'ok')
        return readOkPayload(payload);
    if (!isServerReadStatus(status))
        return { kind: 'failure' };
    const retryAfterMs = readRetryAfterMs(payload.retry_after_ms);
    if (status === 'quota_exceeded') {
        return { kind: 'quota', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return {
        kind: 'status',
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
}
function readOkPayload(payload) {
    const content = typeof payload.content === 'string' ? payload.content : '';
    // An ok without readable text must not reach the model as a successful read.
    if (!content.trim())
        return { kind: 'status', status: 'empty_content' };
    return {
        kind: 'ok',
        content,
        ...optionalString('title', payload.title),
        ...optionalString('finalUrl', payload.final_url),
        ...optionalString('provider', payload.provider),
        ...(typeof payload.cache_hit === 'boolean' ? { cacheHit: payload.cache_hit } : {}),
        ...optionalTimestampMs(payload.fetched_at_ms),
    };
}
/** A retry window must move time forward; zero or negative means "not given". */
function readRetryAfterMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/** Largest timestamp a JavaScript Date can represent (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;
function optionalTimestampMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS
        ? { fetchedAtMs: value }
        : {};
}
function optionalString(key, value) {
    return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}
//# sourceMappingURL=server-web-fetch-reader.js.map