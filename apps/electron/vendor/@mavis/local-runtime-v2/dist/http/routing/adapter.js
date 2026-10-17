import { createSseResponse, encodeHttpResponse, parseHttpRequest, responseHeadersFromHttpServiceContext, } from '@mavis/thrift-gen/runtime';
/**
 * The single runtime adapter shared by every route (design doc §3.4).
 *
 * Error handling contract: this adapter deliberately catches nothing.
 * `parseHttpRequest` failures (malformed body, missing required binding) and
 * handler throws propagate to the errorBoundary middleware installed by
 * `buildApp` — mounting these bindings on an app WITHOUT errorBoundary leaves
 * Hono's generic 500 behavior (same gap as the generated server). Parse
 * errors map to 500 by default (parity with the generated server). A domain
 * may attach a parse-error mapper to its binding; this adapter only consumes
 * that policy mechanically and never identifies routes or domain error codes.
 *
 * Trace-Id note: unlike the generated server (which omits the response
 * Trace-Id when the request has no X-Trace-Id), v2 always writes one because
 * buildRequestContext synthesizes ctx.traceId from requestId (design D8).
 */
export function mountBindings(app, bindings) {
    for (const binding of bindings) {
        const handler = async (c) => {
            const ctx = c.get('requestContext');
            let req;
            try {
                req = await parseHttpRequest(binding.meta, c.req.raw, c.req.param());
            }
            catch (error) {
                if (binding.mapRequestParseError)
                    throw binding.mapRequestParseError(error);
                throw error;
            }
            if (binding.kind === 'sse') {
                const result = await binding.handler(ctx, req);
                // Same 3-arg call shape as the generated server. From here on the
                // response body is a live stream: no middleware may buffer/rewrite it.
                return createSseResponse(binding.meta, ctx, result);
            }
            const resp = await binding.handler(ctx, req);
            return new Response(JSON.stringify(encodeHttpResponse(binding.meta, resp)), {
                status: binding.meta.successStatus ?? 200,
                headers: responseHeadersFromHttpServiceContext(ctx, {
                    'Content-Type': 'application/json',
                    ...binding.responseHeaders,
                }),
            });
        };
        // Hono's app.on treats 'ANY' as a literal method string (silent 404s);
        // api.any routes must go through app.all instead.
        if (binding.meta.method === 'ANY') {
            app.all(binding.meta.path, handler);
        }
        else {
            app.on(binding.meta.method, binding.meta.path, handler);
        }
    }
}
//# sourceMappingURL=adapter.js.map