/**
 * 桌面端错误日志上报的公共类型与可调参数。
 *
 * 本模块为 local-runtime 提供通用错误日志上报能力。首个使用方是 LLM provider 的
 * 物理请求失败，但数据结构不限定事件类型，后续其他子系统可以复用同一链路。
 *
 * 设计约束（见技术方案「MCode 桌面端错误日志批量上报」）：
 * - 只能位于 packages/local-runtime，不得移入 packages/shared，也不得依赖 apps/electron。
 * - 只存内存，不写磁盘、SQLite、outbox 或 dataDir 缓存。
 * - 上报故障不得影响 LLM 请求、自动重试或 turn 结果。
 * - 原始 `event_log` 不做脱敏，但不得以明文离开进程；写入 HTTP 请求体前必须使用
 *   AES-256-GCM 加密（见 ./crypto.ts）。
 */
/** 方案为 {@link DesktopErrorReporterOptions} 指定的默认值。 */
export const DESKTOP_ERROR_REPORTING_DEFAULTS = {
    batchSize: 20,
    flushIntervalMs: 5_000,
    maxBufferEvents: 200,
    maxBatchEvents: 50,
};
/**
 * 单条原始 `event_log` 的最大字节数（16 KiB）。更大的事件整体丢弃，不做截断，
 * 以限制内存和请求大小，并避免发送不完整、可能误导的日志。
 */
export const MAX_EVENT_LOG_BYTES = 16 * 1024;
//# sourceMappingURL=types.js.map