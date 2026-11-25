import { nativeImage } from "electron";
import { normalizeAgentCursorBridgeMessage } from "./agent-cursor-bridge";
import { getBrowserJsDialogGate } from "./browser-js-dialog-registry";
import { captureWebviewFullPage } from "./webview-full-page-screenshot";
export function withDevicePreviewLease(tab, operation) {
    const previous = tab.devicePreviewTaskTail ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    tab.devicePreviewTaskTail = task.then(() => undefined, () => undefined);
    return task;
}
function heldJsDialogGate(tab) {
    const webContents = tab.controller.getWebContents?.();
    return webContents ? getBrowserJsDialogGate(webContents) : undefined;
}
/**
 * Agent surface commands run as page JavaScript, which an open JavaScript
 * dialog blocks until it closes. Stop waiting while a dialog is held or shown
 * in the native box: the command still runs, in order, after the dialog
 * closes, but the Browser action result and handle_js_dialog must not wait
 * for it.
 */
async function awaitUnlessJsDialogHeld(tab, task) {
    const settled = task.then(() => undefined, () => undefined);
    const gate = heldJsDialogGate(tab);
    if (!gate)
        return settled;
    if (gate.hasOpenDialog())
        return;
    let stopWatching = () => undefined;
    const held = new Promise((resolve) => {
        stopWatching = gate.onChange((dialog) => {
            if (dialog)
                resolve();
        });
    });
    try {
        await Promise.race([settled, held]);
    }
    finally {
        stopWatching();
    }
}
function startSurfaceCommand(run) {
    try {
        return Promise.resolve(run());
    }
    catch (error) {
        return Promise.reject(error);
    }
}
export function withAgentCursorHiddenForCapture(tab, capture) {
    // Hiding the cursor needs page JavaScript, which an open dialog blocks.
    if (heldJsDialogGate(tab)?.hasOpenDialog())
        return capture();
    const withHidden = tab.controller.withAgentCursorHiddenForCapture;
    return typeof withHidden === 'function'
        ? withHidden.call(tab.controller, capture)
        : capture();
}
export async function bestEffortHideAgentCursor(tab) {
    // Cursor cleanup must never replace the browser action result or error.
    await awaitUnlessJsDialogHeld(tab, startSurfaceCommand(() => tab.controller.hideAgentCursor?.()));
}
export async function executeWithAgentCursorLease(tab, execute, options = {}) {
    return withDevicePreviewLease(tab, async () => {
        // Keep the cursor parked between ordinary Agent actions so the next
        // pointer action can animate from its last visible target. Only actions
        // that invalidate the page coordinate space clear it.
        if (options.hideBeforeAction === true) {
            await bestEffortHideAgentCursor(tab);
        }
        return execute();
    });
}
async function bestEffortSetAgentExecutionGlow(tab, active) {
    // Visual feedback must never replace the Browser action result or error.
    await awaitUnlessJsDialogHeld(tab, startSurfaceCommand(() => tab.controller.setAgentExecutionGlow?.(active)));
}
export async function executeWithAgentExecutionGlow(tab, execute) {
    const previousLeases = tab.agentExecutionGlowLeases ?? 0;
    tab.agentExecutionGlowLeases = previousLeases + 1;
    // A Browser program holds the glow across its ops; one op does not toggle it.
    if (previousLeases === 0 && tab.agentProgramGlow !== true) {
        await bestEffortSetAgentExecutionGlow(tab, true);
    }
    try {
        return await execute();
    }
    finally {
        const nextLeases = Math.max(0, (tab.agentExecutionGlowLeases ?? 1) - 1);
        tab.agentExecutionGlowLeases = nextLeases;
        if (nextLeases === 0 && tab.agentProgramGlow !== true) {
            await bestEffortSetAgentExecutionGlow(tab, false);
        }
    }
}
/** A Browser program starts working on this tab: the glow stays on until it is released. */
export async function holdAgentProgramGlow(tab) {
    if (tab.agentProgramGlow === true)
        return;
    tab.agentProgramGlow = true;
    if ((tab.agentExecutionGlowLeases ?? 0) === 0)
        await bestEffortSetAgentExecutionGlow(tab, true);
}
/** The program ended or moved to another tab: the glow follows the ops still running. */
export async function releaseAgentProgramGlow(tab) {
    if (tab.agentProgramGlow !== true)
        return;
    tab.agentProgramGlow = false;
    if ((tab.agentExecutionGlowLeases ?? 0) === 0)
        await bestEffortSetAgentExecutionGlow(tab, false);
}
export async function handleAgentCursorBridgeEvent(options) {
    const message = normalizeAgentCursorBridgeMessage(options.envelope);
    if (!message)
        return { success: false, error: 'Invalid agent cursor event envelope' };
    const tab = options.getTab(message.tabId);
    const webContents = tab ? options.getWebContents(tab) : null;
    if (!tab || !options.sender || !webContents || webContents !== options.sender) {
        return { success: false, error: 'Invalid embedded browser event sender' };
    }
    if (tab.sessionId !== message.sessionId) {
        return { success: false, error: 'Agent cursor event identity mismatch' };
    }
    const accepted = tab.controller.handleAgentCursorArrival?.(message) === true;
    return {
        success: true,
        tabId: tab.tabId,
        ...(accepted ? {} : { dropped: 'stale-or-duplicate-arrival' }),
    };
}
export function isAgentCursorVisible(options) {
    const { tab, activeTabId, session, hostWindow } = options;
    if (activeTabId !== tab.tabId ||
        tab.hiddenAt !== null ||
        tab.bounds.x < 0 ||
        tab.bounds.y < 0 ||
        tab.controller.isOffscreen()) {
        return false;
    }
    if (typeof tab.sessionId === 'string' &&
        (session?.selectedTabId !== tab.tabId || session.visibleTabId !== tab.tabId)) {
        return false;
    }
    if (!hostWindow || hostWindow.isDestroyed())
        return false;
    if (typeof hostWindow.isMinimized === 'function' && hostWindow.isMinimized())
        return false;
    if (typeof hostWindow.isFocused === 'function' &&
        !hostWindow.isFocused() &&
        !tab.controller.isDevicePreviewWindowFocused?.())
        return false;
    return true;
}
export async function captureTabScreenshotWithoutAgentCursor(tab, params, getWebContents) {
    const startedAt = Date.now();
    return withAgentCursorHiddenForCapture(tab, async () => {
        if (params.scope === 'fullPage') {
            if (tab.controller.isOffscreen()) {
                throw new Error('Full-page screenshot requires the FilePanel browser to be visible');
            }
            const cdp = tab.controller.getCDPHelper();
            if (!cdp)
                throw new Error('CDP helper not available');
            if (!tab.controller.usesWebview?.()) {
                return cdp.captureScreenshot({ scope: params.scope, clip: params.clip });
            }
            return captureWebviewFullPage(cdp, {
                decodePng: (data) => {
                    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
                    const size = image.getSize();
                    return { ...size, bitmap: image.toBitmap() };
                },
                encodePng: ({ width, height, bitmap }) => tab.controller
                    .normalizeCapturedImage(nativeImage.createFromBitmap(bitmap, { width, height }))
                    .toPNG()
                    .toString('base64'),
            });
        }
        const webContents = getWebContents(tab);
        if (!webContents || webContents.isDestroyed())
            throw new Error('WebContents not available');
        const captureRect = params.scope === 'clip' && params.clip
            ? tab.controller.toCapturePageRect(params.clip)
            : undefined;
        const image = await Promise.race([
            webContents.capturePage(captureRect),
            new Promise((_, reject) => setTimeout(() => reject(new Error('capturePage timed out after 8000ms')), 8000)),
        ]);
        if (image.isEmpty()) {
            throw new Error('Page is offscreen and no rendered frame is available — open the FilePanel browser tab and retry');
        }
        const capturedAt = Date.now();
        const capturedSize = image.getSize();
        const outputSize = tab.controller.getCapturePageOutputSize(params, capturedSize);
        const resizedImage = outputSize.width === capturedSize.width && outputSize.height === capturedSize.height
            ? image
            : image.resize({ ...outputSize, quality: 'best' });
        const outputImage = tab.controller.normalizeCapturedImage?.(resizedImage) ?? resizedImage;
        const data = outputImage.toPNG().toString('base64');
        return {
            data,
            width: outputSize.width,
            height: outputSize.height,
            timing: { captureMs: capturedAt - startedAt, encodeMs: Date.now() - capturedAt },
        };
    });
}
export async function captureFrameWithoutAgentCursor(options) {
    let tab;
    try {
        tab = await options.resolveTab(options.target);
    }
    catch (error) {
        return { success: false, error: options.safeError(error) };
    }
    if (!tab)
        return { success: false, error: 'No embedded tab is available' };
    const webContents = options.getWebContents(tab);
    if (!webContents || webContents.isDestroyed()) {
        return { success: false, error: 'WebContents not available' };
    }
    try {
        const { image, previewFrameBounds } = await options.withTabOperation(tab, 'capture-frame', () => withAgentCursorHiddenForCapture(tab, async () => {
            const captured = await webContents.capturePage();
            const image = tab.controller.normalizeCapturedImage?.(captured) ?? captured;
            // Read before the background host releases its lease; only the foreground
            // fixed-preview window has a placement in the File Panel's coordinate space.
            return { image, previewFrameBounds: tab.controller.getDevicePreviewFrameBounds() };
        }));
        if (image.isEmpty())
            return { success: false, error: 'Capture returned an empty frame' };
        return {
            success: true,
            dataUrl: image.toDataURL(),
            ...(previewFrameBounds ? { previewFrameBounds } : {}),
        };
    }
    catch (error) {
        return { success: false, error: options.safeError(error) };
    }
}
