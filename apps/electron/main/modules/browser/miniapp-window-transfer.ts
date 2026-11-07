import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../config/constants.js";
import { isMainDocumentNavigation } from "./embedded-browser-manager-helpers.js";
const CONFIRMATION_READY_TIMEOUT_MS = 5000;
// A single visible decision must never authorize two different Mini Apps.
const confirmingHosts = new WeakSet();
/** Only the trusted Host renderer can approve; an unavailable UI fails closed without native UI. */
export async function confirmMiniAppWindowTransfer(tab, parent, signal, lifecycle, sourceWindow = parent) {
    if (tab.backendSelection?.rendererBackend !== 'webview')
        return true;
    if (!parent || parent.isDestroyed())
        throw new Error('BROWSER_WEBVIEW_HOST_UNAVAILABLE');
    if (tab.transferringPage ||
        tab.rebuildingPage ||
        tab.windowTransferPhase ||
        confirmingHosts.has(parent)) {
        throw Object.assign(new Error('Mini App window is already changing'), { code: 'busy' });
    }
    signal.throwIfAborted();
    const controller = tab.controller;
    const page = controller.getWebContents();
    const generation = tab.navigationGeneration;
    const runId = tab.miniApp?.runId;
    const contents = parent.webContents;
    const hostFrame = contents.mainFrame;
    if (contents.isDestroyed() || !hostFrame || hostFrame.detached || sourceWindow?.isDestroyed()) {
        throw new Error('BROWSER_WEBVIEW_HOST_UNAVAILABLE');
    }
    const requestId = randomUUID();
    tab.windowTransferPhase = 'confirming';
    confirmingHosts.add(parent);
    try {
        const confirmed = await new Promise((resolve, reject) => {
            let finished = false;
            let waitingForUser = false;
            let stopHost = () => undefined;
            let stopPage = () => undefined;
            const finish = (value) => {
                if (finished)
                    return;
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                ipcMain.removeListener(IPC_CHANNELS.MINIAPP_WINDOW_TRANSFER_CONFIRMATION_RESULT, onResult);
                stopHost();
                stopPage();
                contents.removeListener('did-start-navigation', onHostNavigation);
                sourceWindow?.removeListener('closed', onPageEnd);
                try {
                    if (!contents.isDestroyed())
                        contents.send(IPC_CHANNELS.MINIAPP_WINDOW_TRANSFER_CONFIRMATION_ABORT, requestId);
                }
                catch {
                    // A destroyed Host cannot dismiss its UI, but must still release the pending decision.
                }
                if (value instanceof Error)
                    reject(value);
                else
                    resolve(value);
            };
            const onAbort = () => finish(new Error('Mini App confirmation aborted'));
            const onUnavailable = () => finish(new Error('BROWSER_WEBVIEW_CONFIRMATION_UNAVAILABLE'));
            const onPageEnd = () => finish(new Error('BROWSER_WEBVIEW_STALE_CONFIRMATION'));
            const onHostNavigation = (...args) => {
                if (isMainDocumentNavigation(args))
                    onUnavailable();
            };
            const onResult = (event, value) => {
                if (finished ||
                    contents.isDestroyed() ||
                    hostFrame.detached ||
                    event.sender !== contents ||
                    event.senderFrame !== hostFrame ||
                    contents.mainFrame !== hostFrame)
                    return;
                if (!value || typeof value !== 'object')
                    return;
                const reply = value;
                if (reply.requestId !== requestId)
                    return;
                if (typeof reply.confirmed === 'boolean')
                    finish(reply.confirmed);
                else if (reply.pending === true && !waitingForUser) {
                    waitingForUser = true;
                    clearTimeout(timer);
                    try {
                        if (parent.isDestroyed())
                            return onUnavailable();
                        if (parent.isMinimized())
                            parent.restore();
                        parent.show();
                        parent.focus();
                    }
                    catch {
                        onUnavailable();
                    }
                }
            };
            const timer = setTimeout(onUnavailable, CONFIRMATION_READY_TIMEOUT_MS);
            signal.addEventListener('abort', onAbort, { once: true });
            ipcMain.on(IPC_CHANNELS.MINIAPP_WINDOW_TRANSFER_CONFIRMATION_RESULT, onResult);
            stopHost = lifecycle.observeHostDocumentEnd(contents, onUnavailable);
            if (page)
                stopPage = lifecycle.observeMiniAppPageEnd(page, onPageEnd);
            contents.on('did-start-navigation', onHostNavigation);
            sourceWindow?.on('closed', onPageEnd);
            if (signal.aborted)
                return onAbort();
            try {
                contents.send(IPC_CHANNELS.MINIAPP_WINDOW_TRANSFER_CONFIRMATION_REQUEST, requestId);
            }
            catch {
                onUnavailable();
            }
        });
        signal.throwIfAborted();
        if (parent.isDestroyed() ||
            contents.isDestroyed() ||
            contents.mainFrame !== hostFrame ||
            hostFrame.detached ||
            sourceWindow?.isDestroyed() ||
            tab.controller !== controller ||
            controller.getWebContents() !== page ||
            tab.navigationGeneration !== generation ||
            tab.miniApp?.runId !== runId) {
            throw new Error('BROWSER_WEBVIEW_STALE_CONFIRMATION');
        }
        // Showing the Host modal can cover the live pop-out. Cancellation returns focus to it,
        // never to a replacement window or to the Host for an inline request.
        if (!confirmed &&
            sourceWindow &&
            sourceWindow !== parent &&
            tab.detachedWindow === sourceWindow) {
            if (sourceWindow.isMinimized())
                sourceWindow.restore();
            if (!sourceWindow.isVisible())
                sourceWindow.show();
            sourceWindow.focus();
        }
        return confirmed;
    }
    finally {
        delete tab.windowTransferPhase;
        confirmingHosts.delete(parent);
    }
}
