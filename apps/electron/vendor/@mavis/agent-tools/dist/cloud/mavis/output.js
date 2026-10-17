import { LocalMavisCronValidationError } from '../../shared/cron-schedule-input.js';
import { MavisBaseToolDef } from './mavis-tool-def.js';
export function success(command, response) {
    return { ok: true, command, response };
}
export function failure(command, kind, message, extra = {}) {
    return { ok: false, command, error: { kind, message, ...extra } };
}
/**
 * 业务错误:archon-server 返 `base_resp.status_code != 0` 时构造统一 failure。
 * 部分 RPC 把额外错误信息塞在 `base_resp.status_msg`,展平到 error 顶层方便
 * LLM 直接读。
 */
export function archonBusinessFailure(command, baseResp, path) {
    return failure(command, 'archon_server', baseResp?.status_msg ?? 'archon-server returned non-zero status', {
        status_code: baseResp?.status_code,
        path,
    });
}
/**
 * 把 DofldOutput 包成 LLM 可见的 ToolResult。`text` / `content[0].text` 用纯
 * JSON(无 markdown 转义);`details.archon_response` 保留原 raw 给 UI 消费。
 */
export function toToolResult(output, toolName = MavisBaseToolDef.name) {
    const text = JSON.stringify(output, null, 2);
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { command: output.command, output },
    };
}
/**
 * Caller 抛出的任意 Error → DofldFailure。`AbortError` 单独识别为 `unknown` +
 * 标记 aborted,方便 LLM 知道是 turn-level cancel 而非 archon-server 拒绝。
 */
export function errorToFailure(command, error) {
    if (error instanceof LocalMavisCronValidationError)
        return failure(command, 'validation', error.message, { error_code: error.code });
    if (error instanceof Error && error.name === 'AbortError') {
        return failure(command, 'unknown', 'aborted', { aborted: true });
    }
    return failure(command, 'unknown', 'MAVIS_COMMAND_FAILED: Mavis command failed.', {
        error_code: 'MAVIS_COMMAND_FAILED',
    });
}
//# sourceMappingURL=output.js.map