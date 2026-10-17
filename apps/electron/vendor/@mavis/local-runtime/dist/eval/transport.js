import { logger } from '../common/logger.js';
import { recordCollectionObservation, recordEvalUpload, } from './metrics.js';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Uploads one serialized eval request; every transport/protocol failure is fail-open. */
export async function uploadLocalEvalRequest(input) {
    const { request, sessionId } = input;
    const startedAt = performance.now();
    let outcome = 'network_error';
    let signal;
    try {
        signal = AbortSignal.timeout(input.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        const response = await input.fetchImpl(endpointFor(request, input.options), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${input.accessToken}`,
                'User-Agent': 'MiniMaxAgent',
                'X-Mavis-Desktop-Channel': 'desktop',
                'Content-Type': 'application/json',
            },
            body: request.body,
            signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
            outcome = 'http_error';
            logger.warn({ sessionId, status: response.status }, `[eval-capture] local eval_${request.kind} upload failed`);
            return;
        }
        let payload;
        outcome = 'invalid_response';
        try {
            payload = JSON.parse(responseText);
        }
        catch {
            logger.warn({ sessionId, status: response.status }, `[eval-capture] local eval_${request.kind} upload returned non-JSON response`);
            return;
        }
        if (typeof payload.base_resp?.status_code === 'number' && payload.base_resp.status_code !== 0) {
            outcome = 'business_error';
            logger.warn({
                sessionId,
                statusCode: payload.base_resp.status_code,
                statusMessage: typeof payload.base_resp.status_msg === 'string'
                    ? payload.base_resp.status_msg.slice(0, 200)
                    : undefined,
            }, `[eval-capture] local eval_${request.kind} upload returned a business error`);
        }
        else if (typeof payload.error === 'string' && payload.error.length > 0) {
            outcome = 'business_error';
            logger.warn({ sessionId, error: payload.error.slice(0, 200) }, `[eval-capture] local eval_${request.kind} upload returned an error`);
        }
        else {
            outcome = 'success';
        }
    }
    catch (error) {
        if (signal?.aborted)
            outcome = 'timeout';
        logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, `[eval-capture] local eval_${request.kind} upload failed`);
    }
    finally {
        recordEvalUpload(input.options.metricsClient, request, outcome, performance.now() - startedAt);
    }
}
/**
 * Uploads one Session Clio batch through the same desktop gateway route as raw
 * Eval, and reports the outcome instead of failing open.
 *
 * Raw Eval may drop a diagnostic step; Session Clio may not drop a QA record, so
 * the caller needs to know whether these exact sequences were durably accepted.
 * The response is all-or-nothing for the batch that was sent, so only the sent
 * sequences may be retired — never a high-water mark, which would close holes it
 * never actually delivered.
 */
export async function uploadLocalClioSteps(input) {
    let response;
    try {
        response = await input.fetchImpl(input.options.endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${input.accessToken}`,
                'User-Agent': 'MiniMaxAgent',
                'X-Mavis-Desktop-Channel': 'desktop',
                'Content-Type': 'application/json',
            },
            body: input.body,
            signal: AbortSignal.timeout(input.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        });
    }
    catch (error) {
        return {
            status: 'failed',
            retryable: true,
            reason: `transport:${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
        return {
            status: 'failed',
            // 4xx other than throttling and auth is a request the server will keep
            // rejecting; retrying it forever would only bury the real defect.
            retryable: response.status >= 500 ||
                response.status === 408 ||
                response.status === 429 ||
                response.status === 401 ||
                response.status === 403,
            reason: `http:${response.status}`,
        };
    }
    let payload;
    try {
        payload = JSON.parse(responseText);
    }
    catch {
        return { status: 'failed', retryable: true, reason: 'non-json-response' };
    }
    const statusCode = payload.base_resp?.status_code;
    if (typeof statusCode === 'number' && statusCode !== 0) {
        return { status: 'failed', retryable: true, reason: `business:${statusCode}` };
    }
    if (typeof payload.error === 'string' && payload.error.length > 0) {
        return { status: 'failed', retryable: true, reason: `business:${payload.error.slice(0, 120)}` };
    }
    return { status: 'reported' };
}
function endpointFor(request, options) {
    if (request.kind === 'steps')
        return options.endpoint;
    if (options.snapshotEndpoint)
        return options.snapshotEndpoint;
    const endpoint = new URL(options.endpoint);
    if (!endpoint.pathname.endsWith('/steps/report')) {
        throw new Error('eval steps endpoint must end with /steps/report');
    }
    endpoint.pathname = `${endpoint.pathname.slice(0, -'/steps/report'.length)}/snapshot/report`;
    return endpoint.toString();
}
/** Auth and metadata readers are fail-open, like the HTTP transport. */
export function readLocalEvalAccessToken(options) {
    try {
        return options.getAccessToken()?.trim() || undefined;
    }
    catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[eval-capture] failed to read local eval access token');
        return undefined;
    }
}
export async function collectLocalEvalMetaInfo(options, workspaceDir) {
    if (!options.getMetaInfo)
        return undefined;
    const startedAt = performance.now();
    let totalObserved = false;
    let outcome = 'success';
    try {
        const metaInfo = await options.getMetaInfo(workspaceDir, (event) => {
            if (event.phase === 'total')
                totalObserved = true;
            recordCollectionObservation(options.metricsClient, event);
        });
        if (!metaInfo)
            outcome = 'skipped';
        return metaInfo;
    }
    catch (error) {
        outcome = 'error';
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[eval-capture] failed to collect local MetaInfo');
        return undefined;
    }
    finally {
        if (!totalObserved) {
            recordCollectionObservation(options.metricsClient, {
                phase: 'total',
                outcome,
                durationMs: performance.now() - startedAt,
            });
        }
    }
}
//# sourceMappingURL=transport.js.map