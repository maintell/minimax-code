export function isRuntimeNetworkServiceGoneMessage(message) {
    return (typeof message === 'object' &&
        message !== null &&
        message.type === 'runtime-network-service-gone');
}
const DEFAULT_FALLBACK_FAILURE_THRESHOLD = 3;
const DEFAULT_FALLBACK_REPORT_INTERVAL_MS = 30000;
function requestOrigin(input) {
    try {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.href
                : input.url;
        const origin = new URL(url).origin;
        return origin.startsWith('http://') || origin.startsWith('https://') ? origin : null;
    }
    catch {
        return null;
    }
}
function isAbort(error, input, init) {
    if (init?.signal?.aborted)
        return true;
    if (typeof input === 'object' && 'signal' in input && input.signal?.aborted)
        return true;
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
/**
 * Electron `net` fetch that can be switched once to Node fetch (undici, with
 * the fork-time proxy env and system CA) for the rest of this utility process.
 * A refork starts on Electron `net` again.
 */
export function createNetworkServiceAwareFetch(electronFetch, createNodeFetch, options = {}) {
    const failureThreshold = options.failureThreshold ?? DEFAULT_FALLBACK_FAILURE_THRESHOLD;
    const reportIntervalMs = options.reportIntervalMs ?? DEFAULT_FALLBACK_REPORT_INTERVAL_MS;
    const now = options.now ?? Date.now;
    let current = electronFetch;
    let nodeFetch = null;
    let switched = false;
    let consecutiveFailures = 0;
    let lastReportAt = null;
    const noteFallbackFailure = (origin) => {
        consecutiveFailures += 1;
        if (!origin || !options.onFallbackUnhealthy)
            return;
        if (consecutiveFailures < failureThreshold)
            return;
        const at = now();
        if (lastReportAt !== null && at - lastReportAt < reportIntervalMs)
            return;
        lastReportAt = at;
        try {
            options.onFallbackUnhealthy(origin);
        }
        catch {
            // Reporting must never change the request outcome.
        }
    };
    const fallbackFetch = (async (input, init) => {
        const target = current;
        try {
            const response = await target(input, init);
            consecutiveFailures = 0;
            return response;
        }
        catch (error) {
            if (!isAbort(error, input, init))
                noteFallbackFailure(requestOrigin(input));
            throw error;
        }
    });
    return {
        fetch: ((input, init) => switched ? fallbackFetch(input, init) : current(input, init)),
        fallbackToNodeFetch: () => {
            if (switched)
                return false;
            switched = true;
            nodeFetch = createNodeFetch();
            current = nodeFetch?.fetch ?? globalThis.fetch.bind(globalThis);
            return true;
        },
        close: async () => {
            await nodeFetch?.close();
        },
    };
}
