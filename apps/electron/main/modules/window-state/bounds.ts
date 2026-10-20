/**
 * 主窗口位置与尺寸的纯计算逻辑。
 *
 * 这里刻意不引用 electron，只接受普通矩形数据，便于单测覆盖
 * 越界兜底与异常回落。所有函数对非法输入一律降级到安全默认值，
 * 不抛异常——窗口状态是用户偏好，读失败时把窗口开出来比报错重要。
 */

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function clamp(value, min, max) {
    // max < min 时（窗口比工作区还宽）统一贴到 min 一侧，保证左上角可见。
    return Math.max(min, Math.min(value, max));
}
function intersectionArea(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (width <= 0 || height <= 0)
        return 0;
    return width * height;
}
/**
 * 校验并规整一个矩形（供落盘数据使用）。任何字段缺失、非数字或尺寸非正
 * 都视为无效，返回 null 让调用方回落到默认值。
 */
export function normalizeWindowRectangle(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const { x, y, width, height } = raw;
    if (!isFiniteNumber(x) || !isFiniteNumber(y))
        return null;
    if (!isFiniteNumber(width) || !isFiniteNumber(height))
        return null;
    if (width <= 0 || height <= 0)
        return null;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}
/**
 * 校验并规整落盘数据。任何字段缺失、非数字或尺寸非正都视为无效存档，
 * 返回 null 让调用方回落到默认值。
 */
export function normalizePersistedWindowState(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const candidate = raw;
    const bounds = normalizeWindowRectangle(candidate.bounds);
    if (!bounds)
        return null;
    return {
        bounds,
        maximized: candidate.maximized === true,
    };
}
/**
 * 把存档 bounds 收敛回当前可用工作区。
 *
 * 外接显示器拔掉、分辨率变化后直接套用旧 bounds 会让窗口落在可视区域外，
 * 用户会以为应用打不开，所以恢复前必须重新贴合当前屏幕。
 */
export function clampBoundsToWorkAreas(bounds, workAreas, defaults) {
    const usable = workAreas.filter((area) => isFiniteNumber(area?.x) &&
        isFiniteNumber(area?.y) &&
        isFiniteNumber(area?.width) &&
        isFiniteNumber(area?.height) &&
        area.width > 0 &&
        area.height > 0);
    if (usable.length === 0)
        return null;
    // 选与存档窗口重叠最多的屏幕；完全不重叠（屏幕被拔掉）时回到主屏。
    let target = usable[0];
    let bestArea = 0;
    for (const area of usable) {
        const overlap = intersectionArea(bounds, area);
        if (overlap > bestArea) {
            bestArea = overlap;
            target = area;
        }
    }
    const width = clamp(bounds.width, defaults.minWidth, target.width);
    const height = clamp(bounds.height, defaults.minHeight, target.height);
    const x = clamp(bounds.x, target.x, target.x + target.width - width);
    const y = clamp(bounds.y, target.y, target.y + target.height - height);
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}
/**
 * 启动时解析窗口初始状态。读不到或数据不可用时返回
 * `{ bounds: null }`，调用方沿用默认尺寸。
 */
export function resolveStartupWindowState(options) {
    const normalized = normalizePersistedWindowState(options.stored);
    if (!normalized) {
        return { bounds: null, maximized: false };
    }
    const bounds = clampBoundsToWorkAreas(normalized.bounds, options.workAreas, options.defaults);
    if (!bounds) {
        return { bounds: null, maximized: normalized.maximized };
    }
    return { bounds, maximized: normalized.maximized };
}
/**
 * True when at least part of `bounds` overlaps a current display's work
 * area. Distinct from `clampBoundsToWorkAreas`, which always clamps into
 * the nearest display instead of signalling "not visible anywhere" — this
 * is used where the caller wants to drop a stale *position* outright
 * (e.g. an external display that is no longer connected) rather than
 * relocate it onto whatever screen remains.
 */
export function isBoundsVisibleOnAnyDisplay(bounds, workAreas) {
    return workAreas.some((area) => isFiniteNumber(area?.x) &&
        isFiniteNumber(area?.y) &&
        isFiniteNumber(area?.width) &&
        isFiniteNumber(area?.height) &&
        area.width > 0 &&
        area.height > 0 &&
        intersectionArea(bounds, area) > 0);
}
/**
 * True when at least `minVisiblePx` × `minVisiblePx` of `bounds` overlaps a
 * current display's work area on both axes. Stricter than
 * {@link isBoundsVisibleOnAnyDisplay}, which accepts any nonzero overlap
 * (a 1×1 px sliver) — this is the on-screen rule for a MiniApp's own window,
 * where a barely-visible window is effectively unreachable to the user.
 */
export function hasMinimumVisibleArea(bounds, workAreas, minVisiblePx) {
    return workAreas.some((area) => {
        if (!isFiniteNumber(area?.x) ||
            !isFiniteNumber(area?.y) ||
            !isFiniteNumber(area?.width) ||
            !isFiniteNumber(area?.height) ||
            area.width <= 0 ||
            area.height <= 0) {
            return false;
        }
        const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
        const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
        return overlapWidth >= minVisiblePx && overlapHeight >= minVisiblePx;
    });
}
/**
 * Validates and applies the "off-screen position is dropped, size is kept"
 * rule to a persisted per-pluginId popup bounds record. Returns null for a
 * missing or malformed record — the caller falls back to its own defaults.
 */
export function resolveMiniAppWindowMemory(options) {
    const rect = normalizeWindowRectangle(options.stored);
    if (!rect)
        return null;
    if (isBoundsVisibleOnAnyDisplay(rect, options.workAreas)) {
        return rect;
    }
    return { width: rect.width, height: rect.height };
}
