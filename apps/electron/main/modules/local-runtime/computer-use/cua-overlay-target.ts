import { mappedPreviewTarget } from "./cua-preview-target";
const MAX_ENTRIES = 64;
/**
 * Passive, utility-side bookkeeping. Window bounds are learned only from observations the
 * model already requested; presentation never issues its own native calls, so it cannot
 * poison the driver connection or delay the action.
 */
export function createCuaOverlayTargetTracker() {
    const bounds = new Map();
    const pending = new Map();
    const remember = (map, key, value) => {
        map.delete(key);
        map.set(key, value);
        const oldest = map.keys().next().value;
        if (map.size > MAX_ENTRIES && oldest !== undefined)
            map.delete(oldest);
    };
    const rememberBounds = (pid, windowId, value) => {
        const key = windowKey(pid, windowId);
        const rect = parseRect(value);
        if (key && rect)
            remember(bounds, key, rect);
    };
    return {
        noteMapped(request, payload) {
            const target = mappedPreviewTarget(request, payload);
            const key = target?.kind === 'window' ? windowKey(target.pid, target.windowId) : undefined;
            if (target?.kind === 'desktop')
                remember(pending, request.requestId, { kind: 'desktop' });
            else if (key)
                remember(pending, request.requestId, { kind: 'window', key });
        },
        noteResult(request, payload, result) {
            if (record(result)?.isError)
                return;
            if (request.kind === 'window_set_frame') {
                rememberBounds(payload.pid, payload.window_id, payload);
                return;
            }
            const data = structured(result);
            if (!data)
                return;
            if (request.kind === 'app_state') {
                rememberBounds(payload.pid, payload.window_id, data.window_bounds);
                return;
            }
            if ((request.kind === 'window_list' || request.kind === 'app_launch') &&
                Array.isArray(data.windows)) {
                for (const item of data.windows.slice(0, MAX_ENTRIES)) {
                    const window = record(item);
                    rememberBounds(window?.pid ?? data.pid ?? payload.pid, window?.window_id, window?.bounds);
                }
            }
        },
        targetFor(requestId) {
            const target = pending.get(requestId);
            if (target?.kind === 'desktop')
                return { kind: 'desktop' };
            const rect = target && bounds.get(target.key);
            return rect ? { kind: 'window', bounds: { ...rect } } : undefined;
        },
        forget(requestId) {
            pending.delete(requestId);
        },
    };
}
/** Main-process validation of the semi-trusted utility message. */
export function parseCuaOverlayTarget(value) {
    const target = record(value);
    if (target?.kind === 'desktop')
        return { kind: 'desktop' };
    const rect = target?.kind === 'window' ? parseRect(target.bounds) : undefined;
    return rect ? { kind: 'window', bounds: rect } : undefined;
}
/** Undefined means the target does not identify a display; callers keep their current one. */
export function displayForOverlayTarget(source, target, platform = process.platform) {
    if (!target)
        return undefined;
    // The desktop action facade is pinned to the primary display.
    if (target.kind === 'desktop')
        return source.getPrimaryDisplay();
    const { x, y, width, height } = target.bounds;
    const center = { x: x + width / 2, y: y + height / 2 };
    // macOS CGWindow bounds already share Electron's DIP desktop space. Windows native
    // window rectangles are physical pixels; mixed-DPI layouts need Electron's conversion.
    const point = platform === 'win32' && source.screenToDipPoint ? source.screenToDipPoint(center) : center;
    return source.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
}
function windowKey(pid, windowId) {
    return Number.isSafeInteger(pid) &&
        Number(pid) > 0 &&
        Number.isSafeInteger(windowId) &&
        Number(windowId) > 0
        ? `${pid}:${windowId}`
        : undefined;
}
function parseRect(value) {
    const rect = record(value);
    if (!rect)
        return undefined;
    const { x, y, width, height } = rect;
    if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item)) ||
        width <= 0 ||
        height <= 0)
        return undefined;
    return { x: x, y: y, width: width, height: height };
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function structured(value) {
    const outer = record(value);
    if (!outer || outer.isError)
        return undefined;
    const raw = outer.structuredJson ?? outer.structuredContent ?? outer.rawJson;
    if (raw === undefined)
        return outer;
    try {
        return typeof raw === 'string' ? record(JSON.parse(raw)) : record(raw);
    }
    catch {
        return undefined;
    }
}
