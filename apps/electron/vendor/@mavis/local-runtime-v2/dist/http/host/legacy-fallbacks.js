export function extractRawPathname(rawUrl) {
    const match = rawUrl.match(/^[a-z][a-z\d+\-.]*:\/\/[^/?#]*(\/[^?#]*)?/iu);
    if (match)
        return match[1] || '/';
    return rawUrl.split(/[?#]/u, 1)[0] || '/';
}
export function hasUnsafeEncodedLocalRuntimePath(rawUrl) {
    const rawPathname = extractRawPathname(rawUrl);
    if (!rawPathname.startsWith('/mavis/api/'))
        return false;
    return /%2e|%2f|%5c/iu.test(rawPathname);
}
//# sourceMappingURL=legacy-fallbacks.js.map