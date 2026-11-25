// 供应商请求在拿到 HTTP 响应前失败时（DNS、连接被拒、TLS、地址非法等），对外仍统一返回
// `network`；这里只提取可以安全写进日志的诊断信息，帮助从用户上报日志区分具体原因。
// 只保留 origin 和固定格式的错误码，不记录完整 URL、query、header 或错误原文：
// 非法地址的错误原文会带上用户输入的整段 URL。
const SAFE_CODE = /^[A-Za-z0-9_:.-]{1,64}$/u;
const CHROMIUM_NET_ERROR = /net::ERR_[A-Z0-9_]+/u;
const FIXED_PHRASE = /^[a-z]+(?: [a-z]+){0,4}$/u;
export function describeFetchFailure(error, url) {
    return { origin: safeOrigin(url), kind: errorKind(error), code: errorCode(error) };
}
function safeOrigin(url) {
    try {
        const origin = new URL(url).origin;
        return origin && origin !== 'null' ? origin : 'invalid-url';
    }
    catch {
        return 'invalid-url';
    }
}
function errorKind(error) {
    const name = readField(error, 'name');
    if (typeof name === 'string' && SAFE_CODE.test(name))
        return name;
    return error === null ? 'null' : typeof error;
}
function errorCode(error) {
    // Node fetch（undici）把系统错误放在 cause.code；Electron net.fetch 只在 message 里带 net::ERR_*。
    for (const candidate of [
        readField(readField(error, 'cause'), 'code'),
        readField(error, 'code'),
    ]) {
        if (typeof candidate === 'string' && SAFE_CODE.test(candidate))
            return candidate;
    }
    for (const message of [
        readField(error, 'message'),
        readField(readField(error, 'cause'), 'message'),
    ]) {
        if (typeof message !== 'string')
            continue;
        const match = CHROMIUM_NET_ERROR.exec(message);
        if (match)
            return match[0];
    }
    // undici 对地址层面的拒绝只给固定短语（如 `unknown scheme`、`bad port`），没有错误码。
    // 只接受纯小写字母和空格，保证不会带出主机名、路径或密钥。
    const causeMessage = readField(readField(error, 'cause'), 'message');
    if (typeof causeMessage === 'string' && FIXED_PHRASE.test(causeMessage)) {
        return causeMessage.replaceAll(' ', '_');
    }
    return 'unknown';
}
function readField(value, key) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=fetch-failure.js.map