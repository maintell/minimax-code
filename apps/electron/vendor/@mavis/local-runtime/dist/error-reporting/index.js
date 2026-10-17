/**
 * 桌面端错误日志上报，仅供 local-runtime 使用。
 *
 * 这是一条通用的纯内存链路：批量收集错误事件，用当前登录 token 加密每条
 * `event_log`，再 POST 到 Matrix Gateway；链路故障不得影响主流程。首个使用方为
 * LLM provider 的物理请求失败。设计约束见 ./types.ts，处理流程见 ./reporter.ts。
 */
export { DESKTOP_ERROR_REPORTING_DEFAULTS, MAX_EVENT_LOG_BYTES, } from './types.js';
export { createDesktopErrorReporter, formatErrorLog } from './reporter.js';
export { createLLMFailureReportHook, LLM_REQUEST_FAILURE_CODE_LOCATION, LLM_REQUEST_FAILURE_EVENT_TYPE, } from './llm-integration.js';
export { buildAssociatedData, deriveEventLogKey, encryptEventLog, EVENT_LOG_WIRE_VERSION, HKDF_SALT, } from './crypto.js';
//# sourceMappingURL=index.js.map