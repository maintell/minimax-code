/**
 * Outer of errorBoundary so it observes the FINAL status. For SSE the log
 * line marks stream OPEN; body is never read (SSE iron rule #2).
 *
 * nowMs must be the SAME clock injected into requestContextMiddleware so
 * durationMs = nowMs() - ctx.startedAtMs never mixes clock sources.
 */
export function accessLogMiddleware(deps) {
    return async (c, next) => {
        const ctx = c.get('requestContext');
        await next();
        const durationMs = deps.nowMs() - ctx.startedAtMs;
        const status = c.res.status;
        // Front-door request metrics, emitted BEFORE the log line so a throwing
        // logger can't also drop them (counter/histogram never throw). Hono compose
        // catches downstream throws so `next()` resolves normally — no try/finally
        // needed. SSE logs at stream OPEN, so its durationMs is open-latency, not
        // stream lifetime; count it but skip the duration histogram for SSE.
        deps.metrics?.counter('request_total', 1, { method: c.req.method, status: String(status) });
        const isSse = c.res.headers.get('content-type')?.includes('text/event-stream') ?? false;
        if (!isSse) {
            deps.metrics?.histogram('request_duration_ms', durationMs, { method: c.req.method });
        }
        // ctx itself is the TraceContextLike (traceId narrowed to string) — same
        // ctxInfo idiom as v1 business code, no hand-written traceId field.
        ctx.logger.ctxInfo(ctx, {}, `http ${c.req.method} ${new URL(c.req.url).pathname} status=${status} durationMs=${durationMs}`);
    };
}
//# sourceMappingURL=access-log.mw.js.map