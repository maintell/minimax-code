const FILE_API_UPLOAD_PATH = '/v1/files/upload';
const MESSAGES_API = 'anthropic-messages';
const MESSAGES_COMPATIBILITY_SUFFIX = `/${MESSAGES_API.slice(0, -'-messages'.length)}`;
/**
 * Resolve the server-downlinked provider path inside the already-resolved model
 * base URL. For managed login this preserves `/mavis/api/v1/llm`; for direct
 * Open Platform models it removes only the Messages compatibility suffix.
 */
export function resolveGatewayFileUploadEndpoint(configuredEndpoint, modelBaseUrl) {
    const endpoint = configuredEndpoint?.trim();
    const baseUrl = modelBaseUrl?.trim();
    if (!endpoint || !baseUrl)
        return undefined;
    try {
        const base = new URL(baseUrl);
        if (!isSafeHttpUrl(base))
            return undefined;
        const expected = expectedFileApiUrl(base);
        const configured = endpoint === FILE_API_UPLOAD_PATH ? expected : new URL(endpoint);
        return isSameEndpoint(configured, expected) ? expected.toString() : undefined;
    }
    catch {
        return undefined;
    }
}
function expectedFileApiUrl(base) {
    const result = new URL(base);
    const trimmedPath = base.pathname.replace(/\/+$/u, '');
    const basePath = trimmedPath.endsWith(MESSAGES_COMPATIBILITY_SUFFIX)
        ? trimmedPath.slice(0, -MESSAGES_COMPATIBILITY_SUFFIX.length)
        : trimmedPath;
    result.pathname = `${basePath}${FILE_API_UPLOAD_PATH}`;
    result.search = '';
    result.hash = '';
    return result;
}
function isSameEndpoint(value, expected) {
    return (isSafeHttpUrl(value) &&
        value.origin === expected.origin &&
        value.pathname.replace(/\/+$/u, '') === expected.pathname &&
        !value.search &&
        !value.hash);
}
function isSafeHttpUrl(value) {
    return ((value.protocol === 'https:' || value.protocol === 'http:') &&
        !value.username &&
        !value.password &&
        !value.search &&
        !value.hash);
}
//# sourceMappingURL=file-api-endpoint.js.map