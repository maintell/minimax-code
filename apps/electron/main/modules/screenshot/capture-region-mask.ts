import { configureCaptureWindow } from "./capture-window";
import { BrowserWindow } from "electron";
const ACCENT = '#0094fc';
const BORDER = 2;
/** Integer DIP crop edges with a one-DIP guard so no window or line touches captured pixels. */
function guardedCrop(display, region) {
    return {
        left: Math.max(display.x, Math.floor(display.x + region.x * display.width) - 1),
        top: Math.max(display.y, Math.floor(display.y + region.y * display.height) - 1),
        right: Math.min(display.x + display.width, Math.ceil(display.x + (region.x + region.width) * display.width) + 1),
        bottom: Math.min(display.y + display.height, Math.ceil(display.y + (region.y + region.height) * display.height) + 1),
    };
}
/** Dimmed areas around a scrolling selection. */
export function captureRegionMaskBounds(display, region) {
    const { left, top, right, bottom } = guardedCrop(display, region);
    return [
        { x: display.x, y: display.y, width: display.width, height: top - display.y },
        { x: display.x, y: bottom, width: display.width, height: display.y + display.height - bottom },
        { x: display.x, y: top, width: left - display.x, height: bottom - top },
        { x: right, y: top, width: display.x + display.width - right, height: bottom - top },
    ].filter(({ width, height }) => width > 0 && height > 0);
}
/** Thin frame strips just outside a recording selection. */
export function captureRegionBorderBounds(display, region) {
    const { left, top, right, bottom } = guardedCrop(display, region);
    const clip = (rect) => {
        const x = Math.max(display.x, rect.x);
        const y = Math.max(display.y, rect.y);
        const r = Math.min(display.x + display.width, rect.x + rect.width);
        const b = Math.min(display.y + display.height, rect.y + rect.height);
        return { x, y, width: r - x, height: b - y };
    };
    return [
        clip({ x: left - BORDER, y: top - BORDER, width: right - left + 2 * BORDER, height: BORDER }),
        clip({ x: left - BORDER, y: bottom, width: right - left + 2 * BORDER, height: BORDER }),
        clip({ x: left - BORDER, y: top, width: BORDER, height: bottom - top }),
        clip({ x: right, y: top, width: BORDER, height: bottom - top }),
    ].filter(({ width, height }) => width > 0 && height > 0);
}
/** Dim window content with an accent line on the side facing the selection. */
function maskPage(bounds, display, region) {
    const { left, top, right, bottom } = guardedCrop(display, region);
    const line = {
        x: Math.max(0, left - BORDER - bounds.x),
        y: Math.max(0, top - BORDER - bounds.y),
        right: Math.min(bounds.width, right + BORDER - bounds.x),
        bottom: Math.min(bounds.height, bottom + BORDER - bounds.y),
    };
    let style = '';
    if (bounds.y + bounds.height === top)
        style = `left:${line.x}px;width:${line.right - line.x}px;bottom:0;height:${BORDER}px`;
    else if (bounds.y === bottom)
        style = `left:${line.x}px;width:${line.right - line.x}px;top:0;height:${BORDER}px`;
    else if (bounds.x + bounds.width === left)
        style = `right:0;width:${BORDER}px;top:0;bottom:0`;
    else if (bounds.x === right)
        style = `left:0;width:${BORDER}px;top:0;bottom:0`;
    const html = `<!doctype html><html style="background:transparent"><body style="margin:0;height:100vh;background:rgba(0,0,0,.35)">${style ? `<div style="position:fixed;${style};background:${ACCENT}"></div>` : ''}</body></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
/**
 * Passive, click-through windows that never intersect the crop: scrolling mode
 * dims the rest of the display, recording mode draws a frame. Both are drawn
 * outside the selection, so they never appear in captured pixels.
 */
export function createCaptureRegionMask(display, region, mode, unavailable) {
    const windows = [];
    let disposed = false;
    let resolveReady = () => undefined;
    // Resolves once every mask window is on screen, or when the mask goes away.
    const ready = new Promise((resolve) => {
        resolveReady = resolve;
    });
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        resolveReady();
        for (const win of windows)
            if (!win.isDestroyed())
                win.destroy();
    };
    const failed = () => {
        if (disposed)
            return;
        dispose();
        unavailable(new Error('Capture region mask unavailable'));
    };
    try {
        const bounds = mode === 'record'
            ? captureRegionBorderBounds(display, region)
            : captureRegionMaskBounds(display, region);
        const loading = bounds.map((rect) => {
            const win = new BrowserWindow({
                ...rect,
                show: false,
                frame: false,
                // Native rounded corners would clip the ends of the thin frame strips.
                roundedCorners: false,
                transparent: mode !== 'record',
                backgroundColor: mode === 'record' ? ACCENT : '#00000000',
                focusable: false,
                movable: false,
                resizable: false,
                minimizable: false,
                maximizable: false,
                fullscreenable: false,
                enableLargerThanScreen: true,
                skipTaskbar: true,
                alwaysOnTop: true,
                hasShadow: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    partition: 'capture-region-mask',
                },
            });
            windows.push(win);
            win.setIgnoreMouseEvents(true);
            configureCaptureWindow(win, -1);
            win.setBounds(rect);
            win.webContents.on('render-process-gone', failed);
            win.once('closed', failed);
            // Recording strips are a plain native color; scrolling masks carry the accent line.
            return win
                .loadURL(mode === 'record' ? 'about:blank' : maskPage(rect, display, region))
                .catch(failed);
        });
        void Promise.all(loading)
            .then(() => {
            if (disposed)
                return;
            for (const win of windows)
                win.showInactive();
            resolveReady();
        })
            .catch(failed);
    }
    catch (error) {
        dispose();
        throw error;
    }
    return { dispose, ready };
}
