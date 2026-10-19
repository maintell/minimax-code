import { normalizeAgentCursorBridgeMessage } from "./agent-cursor-bridge";
export function withDevicePreviewLease(tab, operation) {
    const previous = tab.devicePreviewTaskTail ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    tab.devicePreviewTaskTail = task.then(() => undefined, () => undefined);
    return task;
}
export function withAgentCursorHiddenForCapture(tab, capture) {
    const withHidden = tab.controller.withAgentCursorHiddenForCapture;
    return typeof withHidden === 'function'
        ? withHidden.call(tab.controller, capture)
        : capture();
}
export async function bestEffortHideAgentCursor(tab) {
    try {
        await tab.controller.hideAgentCursor?.();
    }
    catch {
        // Cursor cleanup must never replace the browser action result or error.
    }
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
    try {
        await tab.controller.setAgentExecutionGlow?.(active);
    }
    catch {
        // Visual feedback must never replace the Browser action result or error.
    }
}
export async function executeWithAgentExecutionGlow(tab, execute) {
    const previousLeases = tab.agentExecutionGlowLeases ?? 0;
    tab.agentExecutionGlowLeases = previousLeases + 1;
    if (previousLeases === 0)
        await bestEffortSetAgentExecutionGlow(tab, true);
    try {
        return await execute();
    }
    finally {
        const nextLeases = Math.max(0, (tab.agentExecutionGlowLeases ?? 1) - 1);
        tab.agentExecutionGlowLeases = nextLeases;
        if (nextLeases === 0)
            await bestEffortSetAgentExecutionGlow(tab, false);
    }
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
    if (typeof hostWindow.isFocused === 'function' && !hostWindow.isFocused())
        return false;
    return true;
}
export async function captureTabScreenshotWithoutAgentCursor(tab, params, getWebContents) {
    return withAgentCursorHiddenForCapture(tab, async () => {
        if (params.scope === 'fullPage') {
            if (tab.controller.isOffscreen()) {
                throw new Error('Full-page screenshot requires the FilePanel browser to be visible');
            }
            const cdp = tab.controller.getCDPHelper();
            if (!cdp)
                throw new Error('CDP helper not available');
            return cdp.captureScreenshot({ scope: params.scope, clip: params.clip });
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
        const capturedSize = image.getSize();
        const outputSize = tab.controller.getCapturePageOutputSize(params, capturedSize);
        const outputImage = outputSize.width === capturedSize.width && outputSize.height === capturedSize.height
            ? image
            : image.resize({ ...outputSize, quality: 'best' });
        return {
            data: outputImage.toPNG().toString('base64'),
            width: outputSize.width,
            height: outputSize.height,
        };
    });
}
export async function captureFrameWithoutAgentCursor(options) {
    let tab;
    try {
        tab = options.resolveTab(options.target);
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
        const image = await options.withTabOperation(tab, 'capture-frame', () => withAgentCursorHiddenForCapture(tab, () => webContents.capturePage()));
        if (image.isEmpty())
            return { success: false, error: 'Capture returned an empty frame' };
        return { success: true, dataUrl: image.toDataURL() };
    }
    catch (error) {
        return { success: false, error: options.safeError(error) };
    }
}
