/**
 * 桌面端错误上报的 LLM 首期接入。
 *
 * 构造由 local-runtime 注入 PiTurnRunner 的 {@link PiLLMRequestFailureHook}。
 * agent-core 会在每次 provider 物理请求失败时调用它（用户取消已提前过滤）；此处负责
 * 格式化错误并加入一条 `llm_request_failure` 事件。
 *
 * 按方案要求，`code_location` 固定使用“文件路径 + 函数名”，不含行号，并指向
 * agent-core 中实际观测失败的位置。
 */
import { formatErrorLog } from './reporter.js';
/** 首期 LLM provider 失败日志的事件类型。 */
export const LLM_REQUEST_FAILURE_EVENT_TYPE = 'llm_request_failure';
/**
 * LLM 请求失败的固定代码位置，即 agent-core 中物理请求结束的观测点。
 * 刻意省略行号，避免该文件的无关改动导致值变化。
 */
export const LLM_REQUEST_FAILURE_CODE_LOCATION = 'packages/agent-core/src/pi-turn-runner/metrics.ts#recordLLMSettled';
/**
 * 将 {@link DesktopErrorReporter} 适配为 agent-core 失败 hook。返回函数可安全传给
 * `onLLMRequestFailure`：`report(...)` 本身不抛错，agent-core 还会再做一层保护。
 */
export function createLLMFailureReportHook(reporter, options = {}) {
    const appVersion = options.appVersion?.trim();
    return (info) => {
        reporter.report({
            event_type: LLM_REQUEST_FAILURE_EVENT_TYPE,
            event_log: formatErrorLog({
                ...(appVersion ? { appVersion } : {}),
                ...(info.error !== undefined ? { error: info.error } : {}),
                ...(info.providerError !== undefined ? { providerError: info.providerError } : {}),
                ...(info.errorMessage !== undefined ? { errorMessage: info.errorMessage } : {}),
                metricKind: info.metricKind,
                request: info.request,
            }),
            occurred_at_ms: info.occurredAtMs,
            code_location: LLM_REQUEST_FAILURE_CODE_LOCATION,
        });
    };
}
//# sourceMappingURL=llm-integration.js.map