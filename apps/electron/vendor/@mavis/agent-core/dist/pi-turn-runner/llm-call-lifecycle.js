export async function runWithLLMCallLifecycle(lifecycle, input, run) {
    if (input.signal.aborted)
        throw callAborted(input.signal);
    const lease = await lifecycle.open(input);
    let closing;
    const close = () => {
        closing ??= (async () => {
            await Promise.resolve();
            await lease.close();
        })();
        return closing;
    };
    try {
        if (input.signal.aborted)
            throw callAborted(input.signal);
        if (lease.signal.aborted)
            throw callAborted(lease.signal);
        const stream = await awaitCallStream(lease, run, close);
        return withLLMStreamCleanup(stream, { signal: lease.signal, close });
    }
    catch (error) {
        await close();
        throw error;
    }
}
/** Preflight may still be waiting for the first event; cancellation already owns cleanup. */
async function awaitCallStream(lease, run, close) {
    let abort;
    const aborted = new Promise((_resolve, reject) => {
        abort = () => {
            reject(callAborted(lease.signal));
            observe(close());
        };
    });
    lease.signal.addEventListener('abort', abort, { once: true });
    const pending = (async () => {
        if (lease.signal.aborted)
            throw callAborted(lease.signal);
        const stream = await run(lease);
        // A late stream must not escape the cancelled logical call. Observe its settlement;
        // native work stays owned by the host lease until close actually settles.
        if (lease.signal.aborted)
            withLLMStreamCleanup(stream, { signal: lease.signal, close });
        return stream;
    })();
    if (lease.signal.aborted)
        abort();
    try {
        return await Promise.race([pending, aborted]);
    }
    finally {
        lease.signal.removeEventListener('abort', abort);
    }
}
/**
 * Resource settlement for a stream, including result-only consumers and early iterator return.
 * Closing starts immediately on abort, even if the provider iterator does not cooperate.
 * The owner retains non-cooperative native work; this helper never pretends to terminate it.
 */
export function withLLMStreamCleanup(source, owner) {
    let closing;
    let cancelled = false;
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const finish = () => {
        owner.signal.removeEventListener('abort', abort);
        closing ??= (async () => {
            await Promise.resolve();
            await owner.close();
        })();
        return closing;
    };
    const abort = () => {
        cancelled = true;
        rejectAbort(callAborted(owner.signal));
        observe(finish());
    };
    owner.signal.addEventListener('abort', abort, { once: true });
    if (owner.signal.aborted)
        abort();
    const result = (async () => {
        const sourceResult = (async () => {
            await Promise.resolve();
            return source.result();
        })();
        try {
            return await Promise.race([sourceResult, aborted]);
        }
        finally {
            await finish();
        }
    })();
    observe(result);
    return {
        result: () => result,
        [Symbol.asyncIterator]() {
            let inner;
            try {
                inner = source[Symbol.asyncIterator]();
            }
            catch (error) {
                observe(finish());
                throw error;
            }
            return {
                async next(...args) {
                    try {
                        if (cancelled)
                            throw callAborted(owner.signal);
                        const next = await Promise.race([inner.next(...args), aborted]);
                        if (cancelled)
                            throw callAborted(owner.signal);
                        if (next.done || next.value.type === 'done' || next.value.type === 'error')
                            await finish();
                        return next;
                    }
                    catch (error) {
                        await finish();
                        throw error;
                    }
                },
                async return() {
                    // Signal result-only observers too; a dropped stream is not a successful call.
                    cancelled = true;
                    rejectAbort(callAborted(owner.signal));
                    const cleanup = finish();
                    try {
                        return (await inner.return?.()) ?? { done: true, value: undefined };
                    }
                    finally {
                        await cleanup;
                    }
                },
                async throw(error) {
                    cancelled = true;
                    rejectAbort(callAborted(owner.signal));
                    const cleanup = finish();
                    try {
                        if (inner.throw)
                            return await inner.throw(error);
                        throw error;
                    }
                    finally {
                        await cleanup;
                    }
                },
            };
        },
    };
}
async function observe(promise) {
    try {
        await promise;
    }
    catch {
        /* The stream result/iterator and explicit owner close retain the failure. */
    }
}
/** Reasons a host ended its call with: the call's own failure, not a cancellation. */
const CALL_FAILURES = new WeakSet();
/**
 * Ends a call because its own work failed (a credential that cannot be prepared, say). Waiters
 * that race the call's signal then report `error` itself instead of "cancelled".
 */
export function abortLLMCallWithFailure(controller, error) {
    if (error instanceof Error)
        CALL_FAILURES.add(error);
    controller.abort(error);
}
function callAborted(signal) {
    const reason = signal.reason;
    if (reason instanceof Error && CALL_FAILURES.has(reason))
        return reason;
    const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
    const error = new Error(timeout ? 'LLM request timed out' : 'LLM request was cancelled');
    error.name = timeout ? 'TimeoutError' : 'AbortError';
    return error;
}
//# sourceMappingURL=llm-call-lifecycle.js.map