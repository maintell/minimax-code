/**
 * matrix-tools 工具系列共享 helper。
 *
 * 单一职责:把 LLM 给的 input 直接 POST 到 archon-server 暴露的
 * `/matrix/api/v1/mcp/<endpoint>` REST 代理,把响应包成 `ToolResult`。
 * 身份(user_id / biz_id / request_sk)由 RemoteArchonServerAdapter 的
 * HTTP header 自带,api_key 不再进 body —— archon-server 端从 header
 * 取用户身份后自己派生 Mavis chat 上下文。
 *
 * 失败语义:
 *   - `base_resp.status_code != 0` → 固定业务失败(`ok:false`),保留数值
 *     `status_code`，不透传下游 `status_msg`。
 *   - HTTP 层失败(非 2xx / 网络 / JSON 解析失败) → 固定请求失败(`ok:false`),
 *     能识别时保留数值 `http_status`，不把下游原文交给 tool/event/log 出口。
 *
 * 超时:每个工具从 `MATRIX_TOOL_TIMEOUTS` 表查自己的超时(生成类 10 min /
 * 其他 2 min),覆盖 `postJson` 默认的 15s —— 服务端生成动辄数分钟,
 * 15s gate 会把所有生成类工具一律打挂。caller 可以传 `timeoutMs` 覆盖,
 * 单测用得到。
 *
 * 文本摘要:服务端响应字段千差万别(text / list / 计数 + items),不再做
 * "挑一个字段当 ToolResult.text"的猜测,统一 `JSON.stringify(response, …, 2)`
 * 作为 text,details 里附原结构。LLM 自己抽自己需要的字段,人也能直观看 OSS
 * 持久化的 jsonl。如果某个 tool 的响应过大,后续 truncation wrapper
 * (`withToolResultTruncation`)会按 token budget 自动截断。
 */
import { MATRIX_TOOL_TIMEOUTS } from './tool-defs.js';
const MATRIX_TOOL_REQUEST_FAILED = 'MATRIX_TOOL_REQUEST_FAILED';
const MATRIX_TOOL_BUSINESS_FAILED = 'MATRIX_TOOL_BUSINESS_FAILED';
const MATRIX_TOOL_REQUEST_FAILED_TEXT = 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed.';
const MATRIX_TOOL_BUSINESS_FAILED_TEXT = 'MATRIX_TOOL_BUSINESS_FAILED: Matrix tool request was rejected.';
export async function callMatrixTool(opts) {
    const { toolName, path, input, archonServer, signal } = opts;
    if (signal?.aborted)
        throw new Error('Operation aborted');
    const startMs = Date.now();
    logCallStart(opts);
    let resp;
    try {
        resp = await archonServer.postJson(path, input, signal, {
            timeoutMs: resolveTimeout(opts),
        });
    }
    catch (err) {
        const httpStatus = httpStatusFromError(err);
        logCallError(opts, startMs, httpStatus);
        if (signal?.aborted)
            throw err;
        return matrixRequestFailure(toolName, path, httpStatus);
    }
    const baseResp = isRecord(resp.base_resp) ? resp.base_resp : undefined;
    const statusCode = baseResp?.status_code ?? 0;
    logCallEnd(opts, startMs, resp, statusCode);
    if (statusCode !== 0) {
        return matrixBusinessFailure(toolName, path, { statusCode });
    }
    // base_resp 剥掉,信息已经被吸收到 ok:true,留着只是噪声。
    const payload = { ...resp };
    delete payload.base_resp;
    const text = JSON.stringify(payload, null, 2);
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { ok: true, path },
    };
}
export async function callMatrixToolRaw(opts) {
    const { toolName, path, input, archonServer, signal } = opts;
    if (signal?.aborted)
        throw new Error('Operation aborted');
    const startMs = Date.now();
    logCallStart(opts);
    let resp;
    try {
        resp = await archonServer.postJson(path, input, signal, {
            timeoutMs: resolveTimeout(opts),
        });
    }
    catch (err) {
        const httpStatus = httpStatusFromError(err);
        logCallError(opts, startMs, httpStatus);
        if (signal?.aborted)
            throw err;
        return { ok: false, result: matrixRequestFailure(toolName, path, httpStatus) };
    }
    const baseResp = isRecord(resp.base_resp) ? resp.base_resp : undefined;
    const statusCode = baseResp?.status_code ?? 0;
    logCallEnd(opts, startMs, resp, statusCode);
    if (statusCode !== 0) {
        return { ok: false, result: matrixBusinessFailure(toolName, path, { statusCode }) };
    }
    const payload = { ...resp };
    delete payload.base_resp;
    const bizCode = typeof payload.code === 'number' && Number.isInteger(payload.code) ? payload.code : 0;
    if (bizCode !== 0) {
        opts.ctx.matrixLogger?.warn(opts.ctx, `matrix-tools biz_error tool=${toolName} path=${path} code=${MATRIX_TOOL_BUSINESS_FAILED} payload_code=${bizCode} session=${opts.ctx.sessionId} turn=${opts.ctx.turnId}`);
        return { ok: false, result: matrixBusinessFailure(toolName, path, { payloadCode: bizCode }) };
    }
    return { ok: true, response: payload };
}
function resolveTimeout(opts) {
    if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
        return opts.timeoutMs;
    }
    return MATRIX_TOOL_TIMEOUTS[opts.toolName];
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// ─────────────────────────────────────────────────────────────────────────────
// HTTP 调用日志 —— archon-server `/matrix/api/v1/mcp/*` 出口流量。统一 prefix
// `[matrix-tools]`,方便 grafana logQL `{app="cloud-runtime"} |~ "\\[matrix-tools\\]"`
// 一把抓。字段风格跟 `cloud-bash.ts` 对齐:`key=value`(value 含空格的就 JSON
// 序列化),不打 input/response 全文,只打 size + 关键 marker。
// ─────────────────────────────────────────────────────────────────────────────
function logCallStart(opts) {
    const { toolName, path, ctx } = opts;
    const bodyBytes = approxJsonByteSize(opts.input);
    const timeoutMs = resolveTimeout(opts);
    ctx.matrixLogger?.info(ctx, `matrix-tools request tool=${toolName} path=${path} body_bytes=${bodyBytes} timeout_ms=${timeoutMs ?? 'default'} session=${ctx.sessionId} turn=${ctx.turnId}`);
}
function logCallEnd(opts, startMs, resp, statusCode) {
    const { toolName, path, ctx } = opts;
    const durationMs = Date.now() - startMs;
    const respBytes = approxJsonByteSize(resp);
    const ok = statusCode === 0;
    ctx.matrixLogger?.info(ctx, `matrix-tools response tool=${toolName} path=${path} ok=${ok} status_code=${statusCode} duration_ms=${durationMs} resp_bytes=${respBytes} session=${ctx.sessionId} turn=${ctx.turnId}`);
}
function logCallError(opts, startMs, httpStatus) {
    const { toolName, path, ctx, signal } = opts;
    const durationMs = Date.now() - startMs;
    ctx.matrixLogger?.warn(ctx, `matrix-tools error tool=${toolName} path=${path} stage=request code=${MATRIX_TOOL_REQUEST_FAILED} http_status=${httpStatus ?? 'none'} duration_ms=${durationMs} aborted=${signal?.aborted === true} session=${ctx.sessionId} turn=${ctx.turnId}`);
}
function matrixRequestFailure(toolName, path, httpStatus) {
    return {
        tool_name: toolName,
        text: MATRIX_TOOL_REQUEST_FAILED_TEXT,
        content: [{ type: 'text', text: MATRIX_TOOL_REQUEST_FAILED_TEXT }],
        details: {
            ok: false,
            path,
            error_code: MATRIX_TOOL_REQUEST_FAILED,
            ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
        },
    };
}
function matrixBusinessFailure(toolName, path, input) {
    const text = input.payloadCode === 402
        ? 'Insufficient credits (code 402): account credits are insufficient. Please top up credits first. Do NOT retry the same request until credits are available.'
        : MATRIX_TOOL_BUSINESS_FAILED_TEXT;
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: {
            ok: false,
            path,
            error_code: MATRIX_TOOL_BUSINESS_FAILED,
            ...(input.statusCode !== undefined ? { status_code: input.statusCode } : {}),
            ...(input.payloadCode !== undefined ? { code: input.payloadCode } : {}),
        },
    };
}
function httpStatusFromError(error) {
    if (!(error instanceof Error))
        return undefined;
    const match = /\bHTTP\s+(\d{3})\b/i.exec(error.message);
    return match ? Number(match[1]) : undefined;
}
function approxJsonByteSize(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    }
    catch {
        // Circular ref / BigInt 等 stringify 抛错时不要把 caller 也带挂。
        return -1;
    }
}
//# sourceMappingURL=client.js.map