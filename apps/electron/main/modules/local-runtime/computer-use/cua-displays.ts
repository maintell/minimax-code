import { randomUUID } from "node:crypto";
/** Main-process read: never derive monitor layout from resolution or environment variables. */
export function readCuaDisplays(source, platform = process.platform) {
    const primary = source.getPrimaryDisplay().id;
    const cursor = source.getCursorScreenPoint();
    return {
        observed_at: Date.now(),
        coordinate_space: 'electron_dip',
        cursor: { ...cursor, display_id: String(source.getDisplayNearestPoint(cursor).id) },
        // macOS CGWindow bounds use the same top-left logical desktop coordinates.
        // Windows per-monitor DPI conversion must be verified before mixing units.
        matches_native_window_coordinates: platform === 'darwin',
        displays: source.getAllDisplays().map((display) => ({
            id: String(display.id),
            label: display.label,
            primary: display.id === primary,
            internal: display.internal,
            bounds: { ...display.bounds },
            work_area: { ...display.workArea },
            scale_factor: display.scaleFactor,
            rotation: display.rotation,
        })),
    };
}
/** One bounded, cancellable main-process read per request; no cached hotplug state. */
export function createCuaDisplayReader(port, generation) {
    const pending = new Map();
    port.on('message', ({ data }) => {
        if (!data || typeof data !== 'object')
            return;
        const message = data;
        if (message.type !== 'cua-displays-response' || message.generation !== generation)
            return;
        if (typeof message.requestId === 'string')
            pending.get(message.requestId)?.(message);
    });
    return (signal) => {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const finish = (error, value) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                pending.delete(requestId);
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const abort = () => finish(new Error('computer_aborted'));
            const timer = setTimeout(() => finish(new Error('computer_display_read_timeout')), 2000);
            pending.set(requestId, (message) => {
                if (message.error)
                    finish(new Error('computer_display_read_failed'));
                else
                    finish(undefined, message.result);
            });
            signal.addEventListener('abort', abort, { once: true });
            try {
                port.postMessage({ type: 'cua-displays-request', generation, requestId });
            }
            catch {
                finish(new Error('computer_display_channel_closed'));
            }
        });
    };
}
