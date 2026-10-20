import { getStoredMiniAppWindowBounds, setStoredMiniAppWindowBounds } from "../../ipc/storage.ipc";
import logger from "../../utils/logger";
import { resolveMiniAppWindowMemory } from "./bounds";
import { currentWorkAreas } from "./displays";
const PERSIST_THROTTLE_MS = 500;
/**
 * 读取某个 pluginId 上次弹出窗口的记忆。未记录、损坏或读取失败时返回
 * null；记忆位置不在任何当前可见屏幕内时只返回尺寸（不含 x/y），调用方
 * 据此忽略位置、只套用尺寸。
 */
export function readMiniAppWindowMemory(pluginId) {
    let stored;
    try {
        stored = getStoredMiniAppWindowBounds(pluginId);
    }
    catch (error) {
        logger.warn(`[WindowState] Failed to read MiniApp window memory: ${String(error)}`);
        return null;
    }
    if (!stored)
        return null;
    return resolveMiniAppWindowMemory({ stored, workAreas: currentWorkAreas() });
}
function persistNow(pluginId, window) {
    if (window.isDestroyed())
        return;
    try {
        // `x`/`y` are outer (frame-included) screen coordinates from getBounds();
        // `width`/`height` must be the content size from getContentBounds(),
        // matching how openDetachedWindow replays memory via
        // `useContentSize: true`. Mixing outer width/height back in as content
        // size would grow the window by the frame's size on every detach/attach
        // round trip.
        const outer = window.getBounds();
        const content = window.getContentBounds();
        setStoredMiniAppWindowBounds(pluginId, {
            x: Math.round(outer.x),
            y: Math.round(outer.y),
            width: Math.round(content.width),
            height: Math.round(content.height),
        });
    }
    catch (error) {
        logger.warn(`[WindowState] Failed to persist MiniApp window memory: ${String(error)}`);
    }
}
/**
 * 监听一个弹出窗口的几何变化并节流落盘（≥500ms）。调用方在窗口生命周期
 * 终点（attach / tab 销毁）调用返回的 `flush()` 补最后一次立即写入，再调
 * `dispose()` 解绑监听、丢弃未触发的节流写入（窗口即将销毁，不必再写）。
 */
export function attachMiniAppWindowBoundsPersistence(pluginId, window) {
    let timer = null;
    let detached = false;
    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const schedule = () => {
        if (detached)
            return;
        clearTimer();
        timer = setTimeout(() => persistNow(pluginId, window), PERSIST_THROTTLE_MS);
    };
    window.on('resize', schedule);
    window.on('move', schedule);
    return {
        flush: () => {
            clearTimer();
            if (!detached)
                persistNow(pluginId, window);
        },
        dispose: () => {
            if (detached)
                return;
            detached = true;
            clearTimer();
            if (!window.isDestroyed()) {
                window.off('resize', schedule);
                window.off('move', schedule);
            }
        },
    };
}
