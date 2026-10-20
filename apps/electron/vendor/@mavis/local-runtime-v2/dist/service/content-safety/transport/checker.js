import { SAFETY_SCENE } from '../contracts.js';
import { callSafetyApi } from './api.js';
import { callTurnSafetyApi } from './turn-api.js';
export function createContentSafetyChecker(deps) {
    const callApi = deps.apiVersion === 'v2' ? callTurnSafetyApi : callSafetyApi;
    return async (content, scene) => {
        try {
            const authContext = deps.authContextGetter?.();
            const loginEpoch = authContext?.loginEpoch;
            const rejectedToken = authContext?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
            const request = createRequest(deps, content, scene, authContext);
            const result = await callApi(request);
            if (result.errorKind !== 'auth_error' || !rejectedToken || !deps.authContextInvalidator) {
                return result;
            }
            return await retryAfterAuthRefresh({
                deps,
                rejectedToken,
                loginEpoch,
                request,
                result,
                callApi,
            });
        }
        catch {
            // callSafetyApi is designed never to throw (it maps transport / parse
            // failures to a `local_error` result). This is a defensive backstop — e.g.
            // the auth getter throwing — so the checker's contract is airtight: it
            // ALWAYS resolves to a SafetyCheckResult and never rejects. That lets every
            // caller trust `errorKind` + `reviewBlocks` and drop its own try/catch.
            return { pass: false, errorKind: 'local_error' };
        }
    };
}
function createRequest(deps, content, scene, authContext) {
    return {
        content,
        scene,
        authContext,
        routingContext: deps.routingContextGetter?.(),
        fetchImpl: deps.fetchImpl ?? fetch,
        ...(deps.region ? { region: deps.region } : {}),
        ...(deps.buildEnv ? { buildEnv: deps.buildEnv } : {}),
        ...(deps.testBaseURLGetter ? { testBaseURL: deps.testBaseURLGetter() } : {}),
    };
}
async function retryAfterAuthRefresh({ deps, rejectedToken, loginEpoch, request, result, callApi, }) {
    try {
        // A review belongs to the login that submitted its content, even across refresh.
        if (deps.authContextGetter?.()?.loginEpoch !== loginEpoch)
            return result;
        await deps.authContextInvalidator?.(rejectedToken, loginEpoch);
        const freshAuth = deps.authContextGetter?.();
        if (freshAuth?.loginEpoch !== loginEpoch)
            return result;
        const freshToken = freshAuth?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
        if (!freshToken || freshToken === rejectedToken)
            return result;
        const retryScene = result.retryWithV2 && request.scene === SAFETY_SCENE.StreamChunk
            ? SAFETY_SCENE.MessageOutput
            : request.scene;
        return await callApi({ ...request, scene: retryScene, authContext: freshAuth });
    }
    catch {
        return result;
    }
}
//# sourceMappingURL=checker.js.map