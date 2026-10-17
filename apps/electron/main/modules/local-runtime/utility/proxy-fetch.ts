import { EnvHttpProxyAgent, fetch } from "undici";
function readLowercaseFirst(env, lowercaseKey, uppercaseKey) {
    const lowercaseValue = env[lowercaseKey];
    if (lowercaseValue !== undefined) {
        return { key: lowercaseKey, value: lowercaseValue.trim() };
    }
    const uppercaseValue = env[uppercaseKey];
    if (uppercaseValue !== undefined) {
        return { key: uppercaseKey, value: uppercaseValue.trim() };
    }
    return undefined;
}
function nonEmpty(value) {
    return value?.value ? value : undefined;
}
function isValidHttpProxyUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
    }
    catch {
        return false;
    }
}
function report(warn, message) {
    try {
        warn(message);
    }
    catch {
        // Diagnostics must not turn a fail-open proxy configuration into a startup failure.
    }
}
function createBlockedProxyFetch(proxyKey, warn) {
    report(warn, `utility proxy fetch blocked: ${proxyKey} is not a supported HTTP(S) proxy URL`);
    const fetchImpl = (() => Promise.reject(new TypeError('utility proxy configuration unsupported')));
    return {
        fetch: fetchImpl,
        close: async () => { },
    };
}
export function createUtilityProxyFetch(env = process.env, warn = () => { }) {
    const allProxy = nonEmpty(readLowercaseFirst(env, 'all_proxy', 'ALL_PROXY'));
    const httpProxy = nonEmpty(readLowercaseFirst(env, 'http_proxy', 'HTTP_PROXY')) ?? allProxy;
    const httpsProxy = nonEmpty(readLowercaseFirst(env, 'https_proxy', 'HTTPS_PROXY')) ?? allProxy;
    const noProxy = readLowercaseFirst(env, 'no_proxy', 'NO_PROXY')?.value ?? '';
    if (!httpProxy && !httpsProxy)
        return null;
    const configuredProxies = new Map();
    if (httpProxy)
        configuredProxies.set(`${httpProxy.key}\0${httpProxy.value}`, httpProxy);
    if (httpsProxy)
        configuredProxies.set(`${httpsProxy.key}\0${httpsProxy.value}`, httpsProxy);
    for (const proxy of configuredProxies.values()) {
        if (!isValidHttpProxyUrl(proxy.value)) {
            return createBlockedProxyFetch(proxy.key, warn);
        }
    }
    try {
        const dispatcher = new EnvHttpProxyAgent({
            // Explicit empty values keep Undici from re-reading mutable process.env.
            httpProxy: httpProxy?.value ?? '',
            httpsProxy: httpsProxy?.value ?? '',
            noProxy,
        });
        const fetchImpl = (input, init) => fetch(input, {
            ...init,
            dispatcher,
        });
        return {
            fetch: fetchImpl,
            close: () => dispatcher.close(),
        };
    }
    catch (error) {
        const keys = [...new Set([...configuredProxies.values()].map((proxy) => proxy.key))].join(', ');
        const reason = error instanceof Error ? error.name : 'unknown error';
        report(warn, `utility proxy fetch initialization failed for ${keys} (${reason}); using direct Node fetch`);
        return null;
    }
}
