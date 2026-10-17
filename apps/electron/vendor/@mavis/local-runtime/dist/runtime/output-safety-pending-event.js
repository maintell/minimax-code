/**
 * 解析 `stream_resp` payload 字符串为 `RespData`。解析失败返回 undefined
 * （caller 视为"无 text chunk 可审，但仍按 producer 顺序入队"）。
 */
export function parseStreamResp(event) {
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=output-safety-pending-event.js.map