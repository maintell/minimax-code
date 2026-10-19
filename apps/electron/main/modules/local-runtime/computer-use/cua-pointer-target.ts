const record = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const data = value;
    try {
        return typeof data.structuredJson === 'string' ? record(JSON.parse(data.structuredJson)) : data;
    }
    catch {
        return undefined;
    }
};
const rect = (value) => {
    const v = record(value);
    return (!!v &&
        ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k])) &&
        Number(v.width) > 0 &&
        Number(v.height) > 0);
};
/** Presentation metadata only: never re-snapshot AX or alter an input target. */
export class CuaPointerTargets {
    constructor() {
        this.observations = new Map();
    }
    key(request, payload) {
        const target = record(payload.target) ?? payload;
        return JSON.stringify([request.sessionId, request.turnId, target.pid, target.window_id]);
    }
    async observe(request, payload, result, runtime, signal) {
        if (request.kind !== 'app_state')
            return;
        const key = this.key(request, payload);
        this.observations.delete(key);
        const data = record(result);
        if (!data || data.degraded_reason)
            return;
        let bounds = data.window_bounds;
        if (!rect(bounds) && runtime) {
            const target = record(payload.target) ?? payload;
            const listed = record(await runtime.callTool('list_windows', { pid: target.pid, session: payload.session }, signal));
            const windows = listed?.windows;
            bounds = Array.isArray(windows)
                ? windows.map(record).find((w) => w?.window_id === target.window_id)?.bounds
                : undefined;
        }
        if (!rect(bounds) || signal?.aborted)
            return;
        this.observations.set(key, { at: Date.now(), data, bounds });
        const oldest = this.observations.keys().next().value;
        if (this.observations.size > 32 && oldest)
            this.observations.delete(oldest);
    }
    clear(sessionId) {
        for (const key of this.observations.keys()) {
            if (!sessionId || JSON.parse(key)[0] === sessionId)
                this.observations.delete(key);
        }
    }
    async resolve(runtime, request, payload, signal) {
        if (!['click', 'type', 'set_value', 'key'].includes(request.kind) || payload.from_zoom)
            return;
        const target = record(payload.target) ?? payload;
        if (target.kind === 'desktop') {
            if (request.kind === 'click' && Number.isFinite(payload.x) && Number.isFinite(payload.y))
                return { x: Number(payload.x), y: Number(payload.y), desktop: true };
            return;
        }
        const observation = this.observations.get(this.key(request, payload));
        if (!observation || Date.now() - observation.at > 15000)
            return;
        const data = observation.data;
        const listed = record(await runtime.callTool('list_windows', { pid: target.pid, session: payload.session }, signal));
        const windows = listed?.windows;
        const window = Array.isArray(windows)
            ? windows.map(record).find((w) => w?.window_id === target.window_id)
            : undefined;
        if (window?.is_on_screen !== true || !rect(window.bounds))
            return;
        const bounds = window.bounds;
        if (['x', 'y', 'width', 'height'].some((k) => bounds[k] !== observation.bounds[k]))
            return;
        if (typeof payload.element_token === 'string') {
            // AX frames are global logical points; Windows UIA rectangles use native
            // screen pixels and are converted to Electron DIP in the main process.
            if (!['darwin', 'win32'].includes(process.platform))
                return;
            const element = Array.isArray(data.elements)
                ? data.elements.map(record).find((e) => e?.element_token === payload.element_token)
                : undefined;
            const frame = record(element?.frame);
            const normalized = frame && {
                x: frame.x,
                y: frame.y,
                width: frame.w ?? frame.width,
                height: frame.h ?? frame.height,
            };
            if (!rect(normalized))
                return;
            const { x, y, width, height } = normalized;
            const point = { x: x + width / 2, y: y + height / 2 };
            if (point.x < bounds.x ||
                point.y < bounds.y ||
                point.x >= bounds.x + bounds.width ||
                point.y >= bounds.y + bounds.height)
                return;
            return { ...point, desktop: false };
        }
        const x = Number(payload.x), y = Number(payload.y);
        const width = data.screenshot_width, height = data.screenshot_height;
        if (payload.x == null ||
            payload.y == null ||
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            typeof width !== 'number' ||
            typeof height !== 'number' ||
            !(width > 0 && height > 0) ||
            data.screenshot_frame_valid !== true ||
            x < 0 ||
            y < 0 ||
            x >= width ||
            y >= height)
            return;
        return {
            x: bounds.x + (x * bounds.width) / width,
            y: bounds.y + (y * bounds.height) / height,
            desktop: false,
        };
    }
}

