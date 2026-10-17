import { createSafetyFailureReporter } from './diagnostics.js';
import { getRuntimeBuildEnv, getRuntimeRegion, } from '@mavis/config';
import { GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION, postSafetyCheckV2, SafetyCheckV2Error, } from '@mavis/shared/safety-check-v2';
import { managedBackendRoutingHeaders, } from '@mavis/agent-tools/desktop';
import { resolveSafetyApiBase } from './api-base.js';
/** Typed HTTP boundary for local input and output V2 verdicts. */
export async function callLocalSafetyCheckV2(input) {
    const buildEnv = (input.buildEnv ?? getRuntimeBuildEnv)();
    const region = (input.region ?? getRuntimeRegion)();
    const token = input.authContext?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
    const url = `${resolveSafetyApiBase(region, buildEnv, input.testBaseURL)}/mavis/api/v2/content?require_auth=true`;
    const reportFailure = createSafetyFailureReporter(url, 'v2', input.request.scene);
    try {
        const result = await postSafetyCheckV2({
            url,
            headers: {
                'User-Agent': 'MiniMaxAgent',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...managedBackendRoutingHeaders(input.routingContext, input.buildEnv ? buildEnv : process.env.MAVIS_BUILD_ENV),
            },
            body: requestBody(input.request),
            fetchImpl: input.fetchImpl,
            signal: input.signal,
        });
        return parseLocalSafetyCheckV2Result(result);
    }
    catch (error) {
        reportFailure(error instanceof SafetyCheckV2Error
            ? {
                failureKind: error.kind,
                statusCode: error.statusCode,
                transportKind: error.transportKind,
            }
            : { failureKind: 'internal' });
        throw error;
    }
}
function requestBody(request) {
    return {
        scene: request.scene,
        ...(request.image_object_key !== undefined
            ? { image_object_key: request.image_object_key, image_mime_type: request.image_mime_type }
            : {}),
        ...(request.content_text !== undefined ? { content_text: request.content_text } : {}),
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(request.image_url !== undefined ? { image_url: request.image_url } : {}),
        ...(request.files !== undefined ? { files: request.files } : {}),
    };
}
function parseLocalSafetyCheckV2Result(body) {
    validateErrorCode(body);
    const action = validatedAction(body);
    const allow = action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Allow;
    const expectedCode = allow ? 0 : 50201;
    if (body.errorCode !== expectedCode && !(allow && body.errorCode === undefined)) {
        throw new SafetyCheckV2Error('response');
    }
    if (allow)
        return { action: 'allow' };
    if (action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Block) {
        return { action: 'reject' };
    }
    if (action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Replace) {
        if (typeof body.suggestion !== 'string' || !body.suggestion.trim()) {
            throw new SafetyCheckV2Error('response');
        }
        return { action: 'replace', replacementText: body.suggestion };
    }
    return parseGuide(body);
}
function validateErrorCode(body) {
    if (body.errorCode !== undefined) {
        if (typeof body.errorCode !== 'number' || !Number.isInteger(body.errorCode)) {
            throw new SafetyCheckV2Error('response');
        }
        if (body.errorCode !== 0 && body.errorCode !== 50201) {
            throw new SafetyCheckV2Error('upstream', body.errorCode);
        }
    }
}
function parseGuide(body) {
    if (Object.hasOwn(body, 'guide_prompt')) {
        if (typeof body.guide_prompt !== 'string')
            throw new SafetyCheckV2Error('response');
        // Guide without usable prompt text keeps the runner's existing SR fallback.
        return {
            action: 'guide',
            ...(body.guide_prompt.trim() ? { guidePrompt: body.guide_prompt } : {}),
        };
    }
    return { action: 'guide' };
}
function validatedAction(body) {
    const action = body.action;
    if (action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Allow &&
        action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Block &&
        action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Replace &&
        action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Guide) {
        throw new SafetyCheckV2Error('response');
    }
    return action;
}
//# sourceMappingURL=api-v2.js.map