/**
 * 桌面端错误事件的内存批处理器。
 *
 * 职责（方案 §3）：
 * - 在进程内数组中缓存原始事件，不写磁盘，也不持久化。
 * - 缓冲区达到 `batchSize` 时触发发送。
 * - 通过空闲定时器在 `flushIntervalMs` 后发送不满一批的事件。
 * - 超过 `maxBufferEvents` 时优先丢弃最早的事件。
 * - 单次最多发送 `maxBatchEvents` 个事件，更多积压分多次发送。
 *
 * 批处理器不关心传输细节，只把一组原始事件交给注入的 `onFlush`，
 * 不处理认证、加密或 `fetch`。所有调度均保持故障不影响主流程；定时器调用
 * `unref`，不会阻止进程退出，丢弃事件也不会抛错。
 */
import { DESKTOP_ERROR_REPORTING_DEFAULTS } from './types.js';
export class DesktopErrorBatcher {
    buffer = [];
    timer;
    drainPromise;
    onFlush;
    batchSize;
    flushIntervalMs;
    maxBufferEvents;
    maxBatchEvents;
    constructor(options) {
        this.onFlush = options.onFlush;
        this.batchSize = positiveOr(options.batchSize, DESKTOP_ERROR_REPORTING_DEFAULTS.batchSize);
        this.flushIntervalMs = positiveOr(options.flushIntervalMs, DESKTOP_ERROR_REPORTING_DEFAULTS.flushIntervalMs);
        this.maxBufferEvents = positiveOr(options.maxBufferEvents, DESKTOP_ERROR_REPORTING_DEFAULTS.maxBufferEvents);
        this.maxBatchEvents = positiveOr(options.maxBatchEvents, DESKTOP_ERROR_REPORTING_DEFAULTS.maxBatchEvents);
    }
    /** 加入一个事件；先执行缓冲上限，再立即发送满批事件或启动空闲定时器。 */
    add(event) {
        this.buffer.push(event);
        // 限制内存占用：溢出时丢弃最早事件，保留最新失败。
        while (this.buffer.length > this.maxBufferEvents) {
            this.buffer.shift();
        }
        if (this.buffer.length >= this.batchSize) {
            void this.flush();
            return;
        }
        this.armTimer();
    }
    /**
     * 串行取出事件交给 `onFlush`，每批最多 `maxBatchEvents` 个。已有发送进行中时
     * 复用同一个 Promise，保证任意时刻只有一个上传请求。
     */
    flush() {
        this.clearTimer();
        if (this.drainPromise)
            return this.drainPromise;
        if (this.buffer.length === 0)
            return;
        const drain = this.drainAll().finally(() => {
            if (this.drainPromise === drain)
                this.drainPromise = undefined;
            // 防御性处理：若发送结束边界又加入了事件，继续按空闲窗口调度。
            if (this.buffer.length > 0)
                this.armTimer();
        });
        this.drainPromise = drain;
        return drain;
    }
    /** 当前是否仍有缓冲事件或发送中的请求，供优雅发送流程判断。 */
    hasPending() {
        return this.buffer.length > 0 || this.drainPromise !== undefined;
    }
    /** 停止空闲定时器但不执行最终发送，供 {@link DesktopErrorReporter.close} 使用。 */
    stop() {
        this.clearTimer();
    }
    armTimer() {
        if (this.timer !== undefined)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush();
        }, this.flushIntervalMs);
        // 上报定时器不能阻止事件循环或进程退出。
        this.timer.unref?.();
    }
    clearTimer() {
        if (this.timer === undefined)
            return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    async drainAll() {
        while (this.buffer.length > 0) {
            const batch = this.buffer.splice(0, this.maxBatchEvents);
            try {
                await this.onFlush(batch);
            }
            catch {
                // 当前批次直接丢弃，继续处理后续积压；上报失败不能影响业务流程。
            }
        }
    }
}
/** 转为正整数；输入无效时使用 `fallback`。 */
function positiveOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}
//# sourceMappingURL=batcher.js.map