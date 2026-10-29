import { responseHeadersFromHttpServiceContext } from '@mavis/thrift-gen/runtime';
import { toErrorBody } from '../errors.js';
function hasGetResponse(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'getResponse' in err &&
        typeof err.getResponse === 'function');
}
/** Keeps the original failure visible in logs when it was mapped to a stable status. */
function describeError(err) {
    const cause = err instanceof Error ? err.cause : undefined;
    return cause === undefined ? String(err) : `${String(err)} (cause: ${String(cause)})`;
}
/** Start best-effort cancellation without delaying the replacement response. */
export function cancelDiscardedBody(body) {
    if (!body)
        return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cancellation is intentionally detached so a pending stream cannot block the replacement response
    (async () => {
        try {
            await body.cancel();
        }
        catch {
            // A rejected cancel still allows the replacement response to proceed.
        }
    })();
}
/**
 * Catches pre-open failures only. Once an SSE stream Response is returned
 * (2xx text/event-stream), errors travel inside the stream (iron rule #1).
 *
 * Hono v4 note: Hono's compose() intercepts Error throws inside next() before
 * they reach a middleware's try/catch (setting c.error and calling
 * app.onError). We therefore read c.error after awaiting next() and overwrite
 * c.res with our structured error body, which takes priority because compose
 * only overwrites c.res when the handler itself returns a truthy Response
 * value. Non-Error throws (e.g. `throw 'string'`) are NOT intercepted by
 * compose (it rethrows them), so the try/catch below still catches those.
 *
 * Prerequisite: Hono's DEFAULT onError console.errors every thrown error
 * (full stack, even expected 4xx) before this middleware maps it. buildApp
 * MUST register a quiet app.onError to suppress that noise; the mapping here
 * stays authoritative because compose sets c.error before onError runs.
 */
export function errorBoundaryMiddleware() {
    return async (c, next) => {
        const ctx = c.get('requestContext');
        let caught;
        let didCatch = false;
        try {
            await next();
        }
        catch (err) {
            // Only non-Error throws reach here; Errors are absorbed by compose.
            caught = err;
            didCatch = true;
        }
        // didCatch sentinel prevents falsy throws (throw null / throw undefined)
        // from being swallowed by the nullish coalescing operator.
        const err = didCatch ? caught : c.error;
        if (!didCatch && c.error === undefined)
            return;
        let replacement;
        if (hasGetResponse(err)) {
            // HTTPException-like: keep its status/body, add Trace-Id headers.
            const orig = err.getResponse();
            const headers = responseHeadersFromHttpServiceContext(ctx, orig.headers);
            replacement = new Response(orig.body, { status: orig.status, headers });
        }
        else {
            const body = toErrorBody(err);
            if (body.code >= 500)
                ctx.logger.ctxError(ctx, {}, `unhandled error: ${describeError(err)}`);
            replacement = new Response(JSON.stringify(body), {
                status: body.code,
                headers: responseHeadersFromHttpServiceContext(ctx, { 'Content-Type': 'application/json' }),
            });
        }
        // Cancel the discarded response body (unless the replacement reuses the
        // same stream). This in-boundary cancel only covers non-Error throws
        // (where c.res still holds the original stream); for Error throws,
        // compose's res setter orphans the stream BEFORE this middleware resumes
        // — buildApp's quiet onError cancels it there instead.
        if (c.res.body && c.res.body !== replacement.body) {
            cancelDiscardedBody(c.res.body);
        }
        c.res = replacement;
        // Mark the error handled for outer observers (accessLog, tests).
        c.error = undefined;
    };
}
//# sourceMappingURL=error-boundary.mw.js.map