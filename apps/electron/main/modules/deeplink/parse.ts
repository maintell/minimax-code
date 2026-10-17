const SUPPORTED_PROTOCOL_RE = /^minimax(?:-cn)?(?:-test|-staging)?:$/;
const SENSITIVE_DEEP_LINK_PARAMS = new Set([
    'access_token',
    'accesstoken',
    'authorization',
    'cookie',
    'id_token',
    'idtoken',
    'refresh_token',
    'refreshtoken',
    'token',
]);
function isSupportedDeepLinkProtocol(protocol) {
    return SUPPORTED_PROTOCOL_RE.test(protocol);
}
export function isSupportedDeepLinkUrl(url) {
    return parseDeepLink(url) !== null;
}
/**
 * 解析 MiniMax deep link。
 *
 * macOS dev 场景下，浏览器可能回跳到同环境的另一个语言协议
 * （例如英文 dev app 收到 minimax-cn-test://auth-callback）。因此这里按
 * MiniMax 协议族解析，而不是只移除当前构建的 PROTOCOL_NAME。
 */
export function parseDeepLink(url) {
    try {
        const parsed = new URL(url);
        if (!isSupportedDeepLinkProtocol(parsed.protocol))
            return null;
        const pathAction = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
        const actionPath = parsed.hostname
            ? [parsed.hostname, pathAction].filter((part) => part.length > 0).join('/')
            : pathAction;
        const action = actionPath || 'open';
        const params = {};
        parsed.searchParams.forEach((value, key) => {
            params[key] = value;
        });
        const carriesCredential = [...parsed.searchParams.keys()].some((key) => SENSITIVE_DEEP_LINK_PARAMS.has(key.toLowerCase()));
        if (carriesCredential)
            return null;
        return { action, params, rawUrl: url };
    }
    catch {
        return null;
    }
}
