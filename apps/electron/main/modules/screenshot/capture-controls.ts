import { MAX_LONG_HEIGHT, MAX_LONG_AREA } from "./capture-contract";
import { configureCaptureWindow, isOwnFrame } from "./capture-window";
import { nativeImage, BrowserWindow, app, ipcMain } from "electron";
import path from "node:path";
const PREVIEW_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const PREVIEW_MAX_WIDTH = 720;
const PREVIEW_MAX_HEIGHT = 2000;
export function validateCaptureArea(value) {
    const area = value;
    const r = area?.region;
    if (!area ||
        !['scroll', 'record'].includes(area.mode) ||
        !r ||
        ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
        r.x < 0 ||
        r.y < 0 ||
        r.width <= 0 ||
        r.height <= 0 ||
        r.x + r.width > 1 ||
        r.y + r.height > 1)
        throw new Error('Invalid capture region');
    return { mode: area.mode, region: { x: r.x, y: r.y, width: r.width, height: r.height } };
}
/** Long-image progress: real image size plus a bounded tail thumbnail (PNG or JPEG). */
export function validateCaptureProgress(value) {
    const p = value;
    if (!p ||
        !Number.isInteger(p.width) ||
        !Number.isInteger(p.height) ||
        p.width <= 0 ||
        p.height <= 0 ||
        p.width > MAX_LONG_HEIGHT ||
        p.height > MAX_LONG_HEIGHT ||
        p.width * p.height > MAX_LONG_AREA ||
        typeof p.preview !== 'string' ||
        p.preview.length > 2500000 ||
        (p.status !== undefined && (typeof p.status !== 'string' || p.status.length > 200)) ||
        !PREVIEW_PATTERN.test(p.preview))
        throw new Error('Invalid capture progress');
    const image = nativeImage.createFromDataURL(p.preview);
    const size = image.getSize();
    if (image.isEmpty() || size.width > PREVIEW_MAX_WIDTH || size.height > PREVIEW_MAX_HEIGHT)
        throw new Error('Invalid capture thumbnail');
    return {
        width: p.width,
        height: p.height,
        preview: p.preview,
        ...(p.status !== undefined ? { status: p.status } : {}),
    };
}
const GAP = 12;
/** Transparent dock centred under the crop: optional status pill + Cancel / Done. */
// Reserve space below the buttons so hover hints stay inside the native window.
const SCROLL_BAR = { width: 420, height: 84 };
const RECORD_BAR = { width: 164, height: 80 };
/** Feishu-style live preview: a plain image beside the crop, ~0.6x of the crop width. */
const PREVIEW = { minWidth: 120, maxWidth: 320, ratio: 0.6, minHeight: 200 };
function cropBounds(display, region) {
    const left = display.x + region.x * display.width;
    const top = display.y + region.y * display.height;
    return {
        left,
        top,
        right: left + region.width * display.width,
        bottom: top + region.height * display.height,
    };
}
function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function fits(display, rect) {
    return (rect.x >= display.x &&
        rect.y >= display.y &&
        rect.x + rect.width <= display.x + display.width &&
        rect.y + rect.height <= display.y + display.height);
}
/**
 * Control window bounds in DIP, always fully outside the crop (plus a gap that
 * also keeps the window shadow out of the captured pixels) and inside `area`,
 * the display work area, so the macOS menu bar / notch and the Windows taskbar
 * never cover it. Undefined means the selection leaves no room and the tray
 * fallback is used.
 */
export function captureControlsBounds(display, region, mode = 'scroll', area = display) {
    const crop = cropBounds(display, region);
    const clampX = (x, width) => Math.max(area.x + GAP, Math.min(x, area.x + area.width - width - GAP));
    const clampY = (y, height) => Math.max(area.y + GAP, Math.min(y, area.y + area.height - height - GAP));
    const { width, height } = mode === 'record' ? RECORD_BAR : SCROLL_BAR;
    // Recording bar is right-aligned like a system recorder; the scroll dock is centred like Feishu.
    const x = mode === 'record'
        ? clampX(Math.floor(crop.right - width), width)
        : clampX(Math.round((crop.left + crop.right - width) / 2), width);
    const candidates = [
        { x, y: Math.ceil(crop.bottom + GAP), width, height },
        { x, y: Math.floor(crop.top - GAP - height), width, height },
        {
            x: Math.ceil(crop.right + GAP),
            y: clampY(Math.floor(crop.bottom - height), height),
            width,
            height,
        },
        {
            x: Math.floor(crop.left - GAP - width),
            y: clampY(Math.floor(crop.bottom - height), height),
            width,
            height,
        },
    ];
    return candidates.find((rect) => fits(area, rect) &&
        (rect.x + rect.width <= crop.left - GAP + 0.5 ||
            rect.x >= crop.right + GAP - 0.5 ||
            rect.y + rect.height <= crop.top - GAP + 0.5 ||
            rect.y >= crop.bottom + GAP - 0.5));
}
/**
 * Live long-image preview beside the crop (right first, then left), bottom-aligned
 * with the crop so the stitched image grows upwards as in Feishu. It stays inside
 * the work area and never overlaps the control bar; undefined means no room.
 */
export function capturePreviewBounds(display, region, area = display, avoid) {
    const crop = cropBounds(display, region);
    const ideal = Math.min(PREVIEW.maxWidth, Math.max(PREVIEW.minWidth, Math.round((crop.right - crop.left) * PREVIEW.ratio)));
    const height = Math.min(Math.max(Math.round(crop.bottom - crop.top), PREVIEW.minHeight), area.height - 2 * GAP);
    const y = Math.max(area.y + GAP, Math.min(Math.round(crop.bottom - height), area.y + area.height - height - GAP));
    const rightX = Math.ceil(crop.right + GAP);
    const rightRoom = area.x + area.width - GAP - rightX;
    const leftEdge = Math.floor(crop.left - GAP);
    const leftRoom = leftEdge - (area.x + GAP);
    const candidates = [];
    if (rightRoom >= PREVIEW.minWidth)
        candidates.push({ x: rightX, y, width: Math.min(ideal, rightRoom), height });
    if (leftRoom >= PREVIEW.minWidth) {
        const width = Math.min(ideal, leftRoom);
        candidates.push({ x: leftEdge - width, y, width, height });
    }
    return candidates.find((rect) => !avoid || !intersects(rect, avoid));
}
function controlWindowOptions(bounds) {
    return {
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        focusable: false,
        movable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'capture-controls-preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition: 'capture-controls',
            backgroundThrottling: false,
        },
    };
}
export function createCaptureControls(bounds, locale, mode, action, unavailable, previewBounds) {
    // The click-through preview is optional: losing it never ends the capture.
    let preview;
    let previewLoaded = false;
    if (mode === 'scroll' && previewBounds) {
        const view = new BrowserWindow(controlWindowOptions(previewBounds));
        preview = view;
        const dropPreview = () => {
            if (preview !== view)
                return;
            preview = undefined;
            if (!view.isDestroyed())
                view.destroy();
        };
        try {
            view.setIgnoreMouseEvents(true);
            configureCaptureWindow(view);
        }
        catch {
            dropPreview();
        }
        view.webContents.on('preload-error', dropPreview);
        view.webContents.on('render-process-gone', dropPreview);
        view.once('closed', dropPreview);
        if (preview === view)
            void view
                .loadFile(path.join(app.getAppPath(), 'dist/capture/controls.html'), {
                query: { layout: 'preview' },
            })
                .then(() => {
                if (disposed || preview !== view || view.isDestroyed())
                    return;
                previewLoaded = true;
                if (progress)
                    view.webContents.send('capture-controls:progress', progress);
                view.showInactive();
            })
                .catch(dropPreview);
    }
    const win = new BrowserWindow(controlWindowOptions(bounds));
    let disposed = false;
    let loaded = false;
    let progress;
    let recording;
    const channels = ['capture-controls:locale', 'capture-controls:action'];
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        channels.forEach((channel) => ipcMain.removeHandler(channel));
        if (!win.isDestroyed())
            win.destroy();
        if (preview && !preview.isDestroyed())
            preview.destroy();
        preview = undefined;
    };
    channels.forEach((channel) => ipcMain.handle(channel, (event, value) => {
        const isLocale = channel.endsWith(':locale');
        // Only the bar can act; the read-only preview may ask for its locale.
        if (disposed || !(isOwnFrame(event, win) || (isLocale && isOwnFrame(event, preview))))
            throw new Error('Unauthorized capture controls caller');
        if (isLocale)
            return locale;
        if (value !== 'finish' && value !== 'cancel' && value !== 'pause')
            throw new Error('Invalid capture action');
        action(value);
    }));
    configureCaptureWindow(win);
    const failed = () => {
        if (!disposed) {
            dispose();
            unavailable();
        }
    };
    win.webContents.on('preload-error', failed);
    win.webContents.on('render-process-gone', failed);
    win.once('closed', failed);
    void win
        .loadFile(path.join(app.getAppPath(), 'dist/capture/controls.html'), {
        query: { layout: mode },
    })
        .then(() => {
        if (disposed || win.isDestroyed())
            return;
        loaded = true;
        if (progress)
            win.webContents.send('capture-controls:progress', progress);
        if (recording)
            win.webContents.send('capture-controls:state', recording);
        win.showInactive();
    })
        .catch(failed);
    return {
        dispose,
        update(value) {
            if (disposed)
                return;
            progress = value;
            if (loaded)
                win.webContents.send('capture-controls:progress', value);
            if (previewLoaded && preview && !preview.isDestroyed())
                preview.webContents.send('capture-controls:progress', value);
        },
        state(value) {
            if (disposed)
                return;
            recording = value;
            if (loaded)
                win.webContents.send('capture-controls:state', value);
        },
    };
}
