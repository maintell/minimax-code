/**
 * 桌面端错误上报器：把批处理器、加密逻辑和 Gateway 客户端组装为对外的
 * {@link DesktopErrorReporter} 接口。
 *
 * 流程：
 *   report(rawEvent)
 *     → 检查大小，缓存原始明文事件                         [batcher]
 *     → 达到阈值或空闲定时器触发时取出一批                 [batcher]
 *         → 读取实时登录态（token + user_id）               [authContext]
 *         → 使用该 token 加密每条 event_log                 [crypto]
 *         → POST 加密后的批次                              [matrix-api-client]
 *
 * 有意在发送时而非入队时加密：认证当前批次的 token，也正是派生该批次 event_log
 * 密钥的 token，因此批次之间刷新 token 不会造成两边不一致。每个阶段的故障都会被消化，
 * 不得传递给调用方，也不得影响 LLM 请求、重试或 turn 结果。
 */
import { logger } from '../common/logger.js';
import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import { DesktopErrorBatcher } from './batcher.js';
import { encryptEventLog } from './crypto.js';
import { sendDesktopErrorBatch } from './matrix-api-client.js';
import { snapshotErrorValue } from './error-snapshot.js';
import { MAX_EVENT_LOG_BYTES, } from './types.js';
/** 优雅关闭时最终发送的时间上限（方案 §3，尽力控制在 300 ms 内）。 */
const CLOSE_FLUSH_TIMEOUT_MS = 300;
/**
 * 创建可用的 {@link DesktopErrorReporter}。调用方在进程生命周期内持有返回对象，
 * 每个事件调用一次 `report(...)`。
 */
export function createDesktopErrorReporter(options) {
    const nowMs = options.nowMs ?? Date.now;
    // 批处理器负责缓存和调度；此回调负责认证、加密与发送。
    const batcher = new DesktopErrorBatcher({
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
        ...(options.maxBufferEvents !== undefined ? { maxBufferEvents: options.maxBufferEvents } : {}),
        ...(options.maxBatchEvents !== undefined ? { maxBatchEvents: options.maxBatchEvents } : {}),
        onFlush: async (events) => {
            await encryptAndSend(events).catch((error) => {
                // 防御性保护：encryptAndSend 内部已消化异常，这里再兜底一次，避免出现未处理的 reject。
                logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[error-reporting] desktop error flush failed');
            });
        },
    });
    /** 读取登录态、加密每条 event_log 并 POST 当前批次；故障不影响主流程。 */
    async function encryptAndSend(events) {
        const authContext = options.authContextGetter?.();
        const token = authContext?.accessToken?.trim();
        const userId = authContext?.realUserID?.trim();
        // 登录态不完整时既无法加密也无法认证，按方案 §4.1 丢弃当前批次。
        // 不放回缓冲区，避免它混入下一次登录所用的密钥材料。
        if (!token || !userId)
            return;
        // 逐条加密事件日志，并按事件捕获异常，避免单条坏数据拖垮整批有效事件。
        const encrypted = [];
        for (const event of events) {
            try {
                encrypted.push({
                    ...event,
                    event_log: encryptEventLog(event.event_log, {
                        token,
                        userId,
                        event,
                    }),
                });
            }
            catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[error-reporting] failed to encrypt desktop error event; skipping it');
            }
        }
        if (encrypted.length === 0)
            return;
        await sendDesktopErrorBatch({
            events: encrypted,
            authContext,
            routingContext: options.routingContextGetter?.(),
            fetchImpl: options.fetchImpl ?? fetch,
            region: options.region ?? getRuntimeRegion,
            buildEnv: options.buildEnv ?? getRuntimeBuildEnv,
        });
    }
    return {
        report(event) {
            try {
                // 原始日志过大时整条丢弃，绝不截断（方案 §2）；按明文计算大小，同时限制
                // 内存占用和最终请求体大小。
                const byteLength = Buffer.byteLength(event.event_log, 'utf8');
                if (byteLength > MAX_EVENT_LOG_BYTES) {
                    logger.warn({ byteLength, maxBytes: MAX_EVENT_LOG_BYTES, eventType: event.event_type }, '[error-reporting] dropped oversized desktop error event_log');
                    return;
                }
                batcher.add(event);
            }
            catch (error) {
                // report() 不得把异常抛回调用方，即 LLM 失败处理链路。
                logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[error-reporting] failed to enqueue desktop error event');
            }
        },
        async flush() {
            try {
                await batcher.flush();
            }
            catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[error-reporting] desktop error reporter flush failed');
            }
        },
        async close() {
            try {
                batcher.stop();
                // 尽力发送全部缓冲区，并限制耗时，避免慢请求拖住关闭过程。
                const deadline = nowMs() + CLOSE_FLUSH_TIMEOUT_MS;
                await Promise.race([
                    Promise.resolve(batcher.flush()),
                    new Promise((resolve) => {
                        const timeout = setTimeout(resolve, Math.max(0, deadline - nowMs()));
                        timeout.unref?.();
                    }),
                ]);
            }
            catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[error-reporting] desktop error reporter close failed');
            }
        },
    };
}
/**
 * 把宿主观测到的错误材料转换为结构化原始日志。除 `name`、`message`、`stack` 外，
 * 还会保留 provider 原始异常的自有属性、`cause` 链和请求模型信息；内容不脱敏，
 * 只允许在进程内短暂存在，并由上报器在写入 HTTP 请求体前加密。
 */
export function formatErrorLog(input) {
    const log = {
        schemaVersion: 2,
        ...(input.appVersion ? { appVersion: input.appVersion } : {}),
        ...(input.request ? { request: input.request } : {}),
        ...(input.metricKind ? { metricKind: input.metricKind } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.error !== undefined ? { error: snapshotErrorValue(input.error, '$.error') } : {}),
        ...(input.providerError !== undefined
            ? { providerError: snapshotErrorValue(input.providerError, '$.providerError') }
            : {}),
    };
    return safeStringify(log);
}
function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=reporter.js.map