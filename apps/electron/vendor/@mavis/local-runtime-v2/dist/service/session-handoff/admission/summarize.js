import { fallbackHandoffSummary } from './history-digest.js';
const DEFAULT_SUMMARY_TIMEOUT_MS = 20_000;
/**
 * 生成云端会话的第一条消息。第二条 query 由服务端 provisioning 用 handoff.objective
 * 生成,不走这里。
 *
 * 摘要生成失败不该阻断派发:端口缺省、超时、抛错或返回空,一律退回确定性的兜底摘要。
 * 超时用竞速而不是只发 abort —— 端口未必理会 signal,那样派发会被一个可选步骤挂住。
 */
export async function summarizeHandoffHistory(request) {
    const { port, redactedMessages } = request;
    if (!port || redactedMessages.length === 0)
        return fallbackHandoffSummary(redactedMessages);
    const controller = new AbortController();
    let expire = () => undefined;
    const expiry = new Promise((settle) => {
        expire = () => settle(undefined);
    });
    const timer = setTimeout(() => {
        controller.abort();
        expire();
    }, request.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS);
    try {
        const summary = await Promise.race([requestSummary(port, request, controller.signal), expiry]);
        const text = typeof summary === 'string' ? summary.trim() : '';
        return text || fallbackHandoffSummary(redactedMessages);
    }
    finally {
        clearTimeout(timer);
    }
}
/** 端口抛错就是它表达「不可用」的方式,吞掉让调用方走兜底。 */
async function requestSummary(port, request, signal) {
    try {
        return await port.summarize({
            session: request.session,
            redactedMessages: request.redactedMessages,
            signal,
        });
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=summarize.js.map