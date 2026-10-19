import { managedBackendRoutingHeaders, } from '@mavis/agent-tools/desktop';
const MANAGED_PROVIDER_USER_AGENT = 'MiniMaxAgent';
export function buildLocalProviderHeaders(input) {
    const headers = {
        ...(input.headers ?? {}),
        'X-Mavis-Session-Id': input.sessionId,
        'X-Mavis-Agent-Id': input.agentId,
        'X-Mavis-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
    };
    if (input.managedProvider) {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'bedrock-lane')
                delete headers[key];
        }
        headers['User-Agent'] = MANAGED_PROVIDER_USER_AGENT;
        Object.assign(headers, managedBackendRoutingHeaders(input.routingContext, currentBuildEnv()));
    }
    return headers;
}
function currentBuildEnv() {
    const value = process.env.MAVIS_BUILD_ENV;
    return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
        ? value
        : undefined;
}
export function readAgentHeaderId(agentConfig) {
    const id = agentConfig.agent_id;
    if (typeof id === 'string' && id.trim())
        return id.trim();
    return typeof id === 'number' && Number.isFinite(id) ? String(id) : 'main';
}
export function stripUrlCredentials(value) {
    try {
        const parsed = new URL(value);
        if (!parsed.username && !parsed.password)
            return value;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    }
    catch {
        return value;
    }
}
export function createManagedAuthRetryFetch(input) {
    const { fetchImpl, authContextGetter, authContextInvalidator } = input;
    // A resolved model is reused across LLM steps; bind the login, not its expiring token.
    const loginEpoch = input.authContext?.loginEpoch;
    if (!authContextGetter || !loginEpoch)
        return fetchImpl;
    const managedFetch = fetchImpl ?? fetch;
    const recoverToken = async (rejectedToken, signal) => {
        if (!authContextInvalidator)
            return undefined;
        signal?.throwIfAborted();
        await authContextInvalidator(rejectedToken, loginEpoch);
        signal?.throwIfAborted();
        const token = tokenForLogin(authContextGetter(), loginEpoch);
        return token === rejectedToken ? undefined : token;
    };
    return async (request, init) => {
        const signal = requestSignal(request, init);
        signal?.throwIfAborted();
        const retryRequest = request instanceof Request ? request.clone() : request;
        const headers = mergedRequestHeaders(request, init);
        const currentAuth = authContextGetter();
        if (hasLoginChanged(currentAuth, loginEpoch)) {
            return Response.json({ error: { type: 'authentication_error', message: 'Authentication session changed.' } }, { status: 401 });
        }
        const currentToken = tokenForLogin(currentAuth, loginEpoch);
        if (currentToken) {
            headers.set('Authorization', `Bearer ${currentToken}`);
        }
        const requestInit = { ...init, headers };
        const rejectedToken = bearerToken(request, requestInit);
        const response = await managedFetch(request, requestInit);
        if (response.status !== 401 || !rejectedToken)
            return response;
        const freshToken = await recoverToken(rejectedToken, signal);
        if (!freshToken)
            return response;
        await discardResponseBody(response);
        signal?.throwIfAborted();
        const retryToken = tokenForLogin(authContextGetter(), loginEpoch, freshToken);
        if (!retryToken || retryToken === rejectedToken) {
            return response;
        }
        headers.set('Authorization', `Bearer ${retryToken}`);
        return managedFetch(retryRequest, { ...init, headers });
    };
}
function hasLoginChanged(auth, loginEpoch) {
    return (auth?.authState === 'logged_out' || Boolean(auth?.loginEpoch && auth.loginEpoch !== loginEpoch));
}
function tokenForLogin(auth, loginEpoch, recoveredToken) {
    if (hasLoginChanged(auth, loginEpoch))
        return undefined;
    // A pending projection carries no credentials; retain the token just recovered for this login.
    if (auth?.authState === 'pending')
        return recoveredToken;
    if (auth?.loginEpoch !== loginEpoch)
        return undefined;
    return auth.accessToken?.trim();
}
function requestSignal(request, init) {
    if (init?.signal !== undefined)
        return init.signal;
    return request instanceof Request ? request.signal : undefined;
}
async function discardResponseBody(response) {
    try {
        await response.arrayBuffer();
    }
    catch {
        // Some synthetic transports expose an unreadable body; retry does not depend on it.
    }
}
function bearerToken(request, init) {
    const authorization = mergedRequestHeaders(request, init).get('Authorization')?.trim();
    const match = authorization?.match(/^Bearer\s+(.+)$/iu);
    return match?.[1]?.trim();
}
function mergedRequestHeaders(request, init) {
    const headers = new Headers(request instanceof Request ? request.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return headers;
}
//# sourceMappingURL=model-resolver-helpers.js.map