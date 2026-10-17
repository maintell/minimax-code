import { reviewConfigV2 } from './config-api.js';
import { SAFETY_SCENE } from '../contracts.js';
import { classifySafetyTransportError, isSafetyCheckV2Record } from '@mavis/shared/safety-check-v2';
import { createSafetyFailureReporter } from './diagnostics.js';
import { getRuntimeBuildEnv, getRuntimeRegion, } from '@mavis/config';
import { resolveSafetyApiBase } from './api-base.js';
import { managedBackendRoutingHeaders } from '@mavis/agent-tools/desktop';
import {} from '../contracts.js';
export { SAFETY_SCENE } from '../contracts.js';
const CONTENT_REVIEW_TIMEOUT_MS = 10_000;
const UPSTREAM_CODE = {
    SERVICE_UNAVAILABLE: 50200,
};
export async function callSafetyApi(input) {
    if (input.scene === SAFETY_SCENE.AgentConfigName ||
        input.scene === SAFETY_SCENE.AgentConfigAvatar ||
        input.scene === SAFETY_SCENE.CronTitle) {
        return reviewConfigV2(input);
    }
    const { region, url, accessToken, resolvedBuildEnv } = prepareRequest(input);
    const reportFailure = createSafetyFailureReporter(url, 'v1', input.scene);
    let response;
    try {
        response = await input.fetchImpl(url, {
            method: 'POST',
            headers: requestHeaders(input, accessToken, resolvedBuildEnv),
            body: JSON.stringify(requestBody(input)),
            signal: AbortSignal.timeout(CONTENT_REVIEW_TIMEOUT_MS),
        });
    }
    catch (error) {
        reportFailure({ failureKind: 'transport', transportKind: classifySafetyTransportError(error) });
        return { pass: false, reason: 'Service unavailable', errorKind: 'local_error' };
    }
    return readResponse(response, region, reportFailure);
}
function prepareRequest(input) {
    const region = input.region ?? getRuntimeRegion;
    const buildEnv = input.buildEnv ?? getRuntimeBuildEnv;
    const resolvedBuildEnv = buildEnv();
    // Keep legacy URL/text requests on the existing auth policy. Private keys
    // opt into authenticated ownership checks using the gateway's existing flag.
    const authQuery = input.attachments?.some((attachment) => attachment.objectKey)
        ? '?require_auth=true'
        : '';
    const url = `${resolveSafetyApiBase(region(), resolvedBuildEnv, input.testBaseURL)}/mavis/api/v1/content${authQuery}`;
    // Shared OAuth resource requests authenticate with the standard Bearer
    // scheme, matching the managed model and File API paths. Omit the header
    // entirely when there is no token so an anonymous request stays explicit.
    const accessToken = input.authContext?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
    return { region, url, accessToken, resolvedBuildEnv };
}
function requestHeaders(input, accessToken, buildEnv) {
    return {
        'User-Agent': 'MiniMaxAgent',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...managedBackendRoutingHeaders(input.routingContext, input.buildEnv ? buildEnv : process.env.MAVIS_BUILD_ENV),
    };
}
function requestBody(input) {
    return {
        content_text: input.content,
        scene: input.scene,
        ...(input.attachments?.length
            ? {
                files: input.attachments.map((attachment) => ({
                    ...(attachment.objectKey
                        ? { object_key: attachment.objectKey }
                        : { file_url: attachment.fileUrl }),
                    file_name: attachment.fileName,
                })),
            }
            : {}),
    };
}
async function readResponse(response, region, reportFailure) {
    let text;
    try {
        text = await response.text();
    }
    catch (error) {
        reportFailure({
            failureKind: 'transport',
            transportKind: classifySafetyTransportError(error),
            statusCode: response.status,
        });
        return { pass: false, reason: 'Service response could not be read', errorKind: 'local_error' };
    }
    if (!response.ok) {
        reportFailure({
            failureKind: response.status === 401 || response.status === 403 ? 'auth' : 'http',
            statusCode: response.status,
        });
        // Non-2xx from the gateway, split by class so an auth failure can never be a
        // bypass:
        //   5xx  → gateway reachable but genuinely degraded → `api_error` (fail open:
        //          a transient server hiccup must not block a legitimate turn / write).
        //   4xx  → client-side problem: missing / expired auth token (401/403), bad
        //          request, etc. We are not authenticated / the request is not
        //          acceptable, so there is NO valid verdict on our side → `local_error`
        //          (fail closed). Treating 401/403 as `api_error` would let an
        //          unauthenticated user bypass every content gate.
        const error = readErrorText(text);
        return {
            pass: false,
            reason: error ?? `Service returned ${response.status}`,
            errorKind: httpErrorKind(response.status),
        };
    }
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        reportFailure({ failureKind: 'response', statusCode: response.status });
        // 2xx but the body is not JSON — we cannot read a verdict. Treat as no
        // gateway confirmation → fail closed on the input path.
        return { pass: false, reason: 'Service returned non-JSON response', errorKind: 'local_error' };
    }
    return readVerdict(data, region, response.status, reportFailure);
}
function readVerdict(data, region, statusCode, reportFailure) {
    if (!isSafetyCheckV2Record(data) || typeof (data.pass ?? data.safe) !== 'boolean') {
        reportFailure({ failureKind: 'response', statusCode });
        // 2xx JSON but no boolean pass/safe field — again no usable verdict → fail
        // closed on the input path.
        return {
            pass: false,
            reason: 'Service returned unexpected response format',
            errorKind: 'local_error',
        };
    }
    const pass = (data.pass ?? data.safe);
    const activeRegion = region();
    const upstreamCode = data.errorCode;
    if (!pass && upstreamCode === UPSTREAM_CODE.SERVICE_UNAVAILABLE) {
        reportFailure({ failureKind: 'upstream', statusCode: upstreamCode });
    }
    return {
        pass,
        reason: firstString(data.reason, data.error),
        suggestion: activeRegion === 'cn' ? firstString(data.suggestion, data.fix_response) : undefined,
        ...(!pass
            ? {
                errorKind: upstreamCode === UPSTREAM_CODE.SERVICE_UNAVAILABLE
                    ? 'api_error'
                    : 'rejected',
            }
            : {}),
    };
}
function readErrorText(text) {
    try {
        const parsed = JSON.parse(text);
        return typeof parsed.error === 'string' ? parsed.error : undefined;
    }
    catch {
        return undefined;
    }
}
function firstString(primary, fallback) {
    if (typeof primary === 'string')
        return primary;
    return typeof fallback === 'string' ? fallback : undefined;
}
function httpErrorKind(status) {
    if (status === 401 || status === 403)
        return 'auth_error';
    return status >= 500 ? 'api_error' : 'local_error';
}
//# sourceMappingURL=api.js.map