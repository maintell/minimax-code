export const MODEL_ACCESS_HOST_MAX_STREAM_CHUNK = 64 * 1024;
/** @internal Exported for focused tests. */
export const MODEL_ACCESS_HOST_FRAME_OVERHEAD = 2048;
export const MODEL_ACCESS_HOST_DEFAULT_WINDOW = 512 * 1024;
const MODEL_ACCESS_HOST_MAX_WINDOW = 64 * 1024 * 1024;
/** Byte credit includes a fixed frame charge so tiny chunks cannot fill the queue for free. */
export class ModelAccessHostCreditGate {
    free;
    stopped = false;
    waiter;
    constructor(window) {
        if (!Number.isSafeInteger(window) || window <= MODEL_ACCESS_HOST_FRAME_OVERHEAD)
            throw new Error('host_stream_window_invalid');
        this.free = Math.min(window, MODEL_ACCESS_HOST_MAX_WINDOW);
    }
    async take(want) {
        if (this.stopped)
            return -1;
        const available = Math.min(want, this.free - MODEL_ACCESS_HOST_FRAME_OVERHEAD);
        if (available > 0)
            return available;
        return new Promise((resolve) => {
            this.waiter = (ok) => resolve(ok ? Math.min(want, this.free - MODEL_ACCESS_HOST_FRAME_OVERHEAD) : -1);
        });
    }
    spend(bytes) {
        this.free -= bytes + MODEL_ACCESS_HOST_FRAME_OVERHEAD;
        if (this.free < 0)
            throw new Error('host_stream_credit_overrun');
    }
    add(credit) {
        if (this.stopped || !Number.isSafeInteger(credit) || credit <= 0)
            return;
        this.free = Math.min(MODEL_ACCESS_HOST_MAX_WINDOW, this.free + credit);
        if (this.waiter && this.free > MODEL_ACCESS_HOST_FRAME_OVERHEAD) {
            const wake = this.waiter;
            this.waiter = undefined;
            wake(true);
        }
    }
    stop() {
        this.stopped = true;
        const wake = this.waiter;
        this.waiter = undefined;
        wake?.(false);
    }
}
export function validStreamWindow(value) {
    return (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > MODEL_ACCESS_HOST_FRAME_OVERHEAD &&
        value <= MODEL_ACCESS_HOST_MAX_WINDOW);
}
//# sourceMappingURL=stream.js.map