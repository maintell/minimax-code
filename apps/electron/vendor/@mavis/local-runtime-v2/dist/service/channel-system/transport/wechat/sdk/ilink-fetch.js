let fetchImpl;
export function setIlinkFetch(fetch) {
    fetchImpl = fetch;
}
export function ilinkFetch(url, init) {
    if (!fetchImpl) {
        throw new Error('WeChat iLink HTTP transport is not configured');
    }
    return fetchImpl(url, init);
}
//# sourceMappingURL=ilink-fetch.js.map