/**
 * Authorized fetch layer for HTTP / SSE MCP transports (plan §4.2).
 *
 * Follows redirects hop by hop (`redirect: 'manual'`) so the Bearer token and every injected
 * header are sent only to the MCP server origin. With an authorizer it also classifies 401 /
 * 403(insufficient_scope) responses from the MCP origin, replays once with a fresh token, and
 * reports authorization failures without relying on exception propagation: eventsource flattens
 * SSE GET exceptions into strings and reconnects, so SSE GETs get the rejection response back.
 */
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpAuthRequiredError, findMcpAuthRequiredError, } from '../auth.js';
const MAX_REDIRECTS = 10;
export function createAuthorizedFetch(options) {
    const mcpOrigin = options.serverUrl.origin;
    const originHeaders = options.originHeaders ?? {};
    const injectedNames = Object.keys(originHeaders).map((name) => name.toLowerCase());
    const { authorizer, fetchImpl } = options;
    const send = async (request, token) => {
        let { url, method, body } = request;
        const baseHeaders = new Headers(request.headers);
        for (let redirects = 0;; redirects += 1) {
            const headers = new Headers(baseHeaders);
            headers.delete('authorization');
            for (const name of injectedNames)
                headers.delete(name);
            if (new URL(url).origin === mcpOrigin) {
                for (const [name, value] of Object.entries(originHeaders))
                    headers.set(name, value);
                if (token)
                    headers.set('authorization', `Bearer ${token}`);
            }
            const response = await fetchImpl(url, {
                ...request.rest,
                method,
                headers,
                ...(body === undefined || body === null ? {} : { body }),
                ...(request.signal ? { signal: request.signal } : {}),
                redirect: 'manual',
            });
            const location = isRedirect(response.status) ? response.headers.get('location') : null;
            if (!location)
                return { response, url };
            await response.body?.cancel();
            if (redirects === MAX_REDIRECTS)
                throw new TypeError('MCP redirect limit exceeded');
            const switchToGet = response.status === 303 ||
                ((response.status === 301 || response.status === 302) && method === 'POST');
            if (switchToGet) {
                method = 'GET';
                body = undefined;
                baseHeaders.delete('content-type');
                baseHeaders.delete('content-length');
            }
            url = new URL(location, url).href;
        }
    };
    const challengeOf = (response, url) => {
        if (new URL(url).origin !== mcpOrigin)
            return undefined;
        if (response.status !== 401 && response.status !== 403)
            return undefined;
        const params = extractWWWAuthenticateParams(response);
        const challenge = {
            ...(params.resourceMetadataUrl
                ? { resourceMetadataUrl: params.resourceMetadataUrl.href }
                : {}),
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.error ? { error: params.error } : {}),
        };
        if (response.status === 403 && challenge.error !== 'insufficient_scope')
            return undefined;
        return { status: response.status, challenge };
    };
    const fail = async (error, request, response) => {
        await response?.body?.cancel();
        options.onAuthRequired?.(error);
        if (isSseGet(request)) {
            // eventsource treats non-200 as fatal (CLOSED, no reconnect); the SDK streamable GET
            // reports it through onerror. Neither path needs the original body.
            return new Response(null, { status: error.reason === 'insufficient_scope' ? 403 : 401 });
        }
        throw error;
    };
    return async (input, init) => {
        const request = await toReplayableRequest(input, init);
        if (!authorizer)
            return (await send(request, undefined)).response;
        let token;
        try {
            token = await authorizer.authorize(request.signal ?? undefined);
        }
        catch (error) {
            const authError = findMcpAuthRequiredError(error);
            if (!authError)
                throw error;
            return fail(authError, request, undefined);
        }
        const first = await send(request, token);
        const firstChallenge = challengeOf(first.response, first.url);
        if (!firstChallenge)
            return first.response;
        if (!token) {
            return fail(new McpAuthRequiredError('auth_required', firstChallenge.challenge), request, first.response);
        }
        await first.response.body?.cancel();
        let fresh;
        try {
            fresh = await authorizer.onChallenge({ ...firstChallenge, usedToken: token });
        }
        catch (error) {
            const authError = findMcpAuthRequiredError(error);
            if (!authError)
                throw error;
            return fail(authError, request, undefined);
        }
        const replay = await send(request, fresh);
        const replayChallenge = challengeOf(replay.response, replay.url);
        if (!replayChallenge)
            return replay.response;
        let authError;
        try {
            await authorizer.onChallenge({ ...replayChallenge, usedToken: fresh, replayed: true });
            authError = new McpAuthRequiredError(replayChallenge.status === 403 ? 'insufficient_scope' : 'reauth_required', replayChallenge.challenge);
        }
        catch (error) {
            const found = findMcpAuthRequiredError(error);
            if (!found)
                throw error;
            authError = found;
        }
        return fail(authError, request, replay.response);
    };
}
async function toReplayableRequest(input, init) {
    if (input instanceof Request) {
        const method = init?.method ?? input.method;
        const body = init?.body ?? (method === 'GET' || method === 'HEAD' ? undefined : await input.text());
        return {
            url: input.url,
            method,
            headers: new Headers(init?.headers ?? input.headers),
            body,
            signal: init?.signal ?? input.signal,
            rest: restInit(init),
        };
    }
    return {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
        signal: init?.signal,
        rest: restInit(init),
    };
}
function restInit(init) {
    if (!init)
        return {};
    const { headers: _headers, body: _body, method: _method, signal: _signal, redirect: _redirect, ...rest } = init;
    return rest;
}
function isSseGet(request) {
    return (request.method === 'GET' &&
        (request.headers.get('accept') ?? '').toLowerCase().includes('text/event-stream'));
}
function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
//# sourceMappingURL=authorized-fetch.js.map