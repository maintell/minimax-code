/**
 * macOS Dock/Finder file-open integration.
 *
 * Electron emits `open-file` when the user drags files onto the Dock app icon.
 * The listener must be registered before `ready`; file paths are queued until a
 * primary renderer window can receive them.
 */
import { ipcMain, app } from "electron";
import path from "path";
import { IPC_CHANNELS } from "../../config/constants";
import { logger } from "../../utils";
import { getWindowsOpenFilePathsFromAdditionalData, getWindowsOpenFilePaths } from "./windows-file-arguments";
import { captureSelectedFileIssuer } from "../document-preview/selected-file-authority";
let pendingFilePaths = [];
let pendingFilePathSet = new Set();
let getTargetWindow = null;
let registered = false;
let readyReceivers = new WeakSet();
let observedReceivers = new WeakSet();
let flushScheduledForWindowId = null;
let flushTimer = null;
function onReceiverStateChanged(event, ready) {
    const window = getReceivableWindow();
    // Login windows, other renderers and subframes cannot consume the file queue.
    if (!window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame) {
        return;
    }
    const receiver = event.sender;
    if (ready !== true) {
        readyReceivers.delete(receiver);
        return;
    }
    if (!observedReceivers.has(receiver)) {
        observedReceivers.add(receiver);
        receiver.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            // Subframe loads and same-document navigation keep the main renderer's subscription.
            if (isMainFrame && !isInPlace)
                readyReceivers.delete(receiver);
        });
    }
    readyReceivers.add(receiver);
    logger.info(`[Dock] File receiver ready in window ${window.id}`);
    scheduleDeferredFlush();
}
function normalizeFilePath(filePath) {
    if (!filePath.trim())
        return null;
    return (process.platform === 'win32' ? path.win32 : path).resolve(filePath);
}
function enqueueFilePath(filePath) {
    const normalized = normalizeFilePath(filePath);
    if (!normalized)
        return false;
    if (pendingFilePathSet.has(normalized)) {
        logger.info(`[Dock] Ignoring duplicate pending file: ${normalized}`);
        return false;
    }
    pendingFilePaths.push(normalized);
    pendingFilePathSet.add(normalized);
    logger.info(`[Dock] Queued file from Dock: ${normalized}`);
    return true;
}
function getReceivableWindow(explicitWindow) {
    const window = explicitWindow ?? getTargetWindow?.() ?? null;
    if (!window || window.isDestroyed())
        return null;
    return window;
}
function isWindowReady(window) {
    return (!window.webContents.isDestroyed() &&
        !window.webContents.isLoading() &&
        window.webContents.getURL() !== '');
}
function scheduleDeferredFlush() {
    if (flushTimer)
        return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushDockFileQueue();
    }, 0);
}
function clearDeferredFlush() {
    if (!flushTimer)
        return;
    clearTimeout(flushTimer);
    flushTimer = null;
}
function scheduleFlushWhenReady(window) {
    clearDeferredFlush();
    if (flushScheduledForWindowId === window.id)
        return;
    flushScheduledForWindowId = window.id;
    let settled = false;
    const flush = () => {
        if (settled)
            return;
        settled = true;
        window.webContents.removeListener('did-finish-load', flush);
        window.webContents.removeListener('did-stop-loading', flush);
        flushScheduledForWindowId = null;
        flushDockFileQueue(window);
    };
    window.webContents.once('did-finish-load', flush);
    window.webContents.once('did-stop-loading', flush);
    window.once('closed', () => {
        if (flushScheduledForWindowId === window.id) {
            flushScheduledForWindowId = null;
        }
    });
}
/**
 * Register the macOS open-file listener early. Safe to call more than once.
 */
export function setupDockFileOpenHandler(targetWindowProvider) {
    getTargetWindow = targetWindowProvider;
    setupFileOpenEventHandlers();
}
/** Register directly after acquiring the instance lock, before async startup. */
export function setupFileOpenEventHandlers() {
    if (registered)
        return;
    registered = true;
    ipcMain.on(IPC_CHANNELS.DOCK_FILE_RECEIVER_READY, onReceiverStateChanged);
    if (process.platform === 'win32') {
        const receive = (argv, source, additionalData) => {
            const filePaths = getWindowsOpenFilePathsFromAdditionalData(additionalData) ??
                getWindowsOpenFilePaths(argv);
            logger.info(`[Dock] ${source} received ${filePaths.length} file(s)`);
            let queued = false;
            for (const filePath of filePaths) {
                queued = enqueueFilePath(filePath) || queued;
            }
            if (queued)
                scheduleDeferredFlush();
        };
        app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => receive(argv, 'second-instance', additionalData));
        receive(process.argv, 'launch');
        return;
    }
    if (process.platform !== 'darwin') {
        logger.info('[Dock] Non-macOS platform; open-file listener not registered');
        return;
    }
    app.on('open-file', (event, filePath) => {
        event.preventDefault();
        const queued = enqueueFilePath(filePath);
        if (queued) {
            scheduleDeferredFlush();
        }
    });
    logger.info('[Dock] Registered macOS open-file listener');
}
/**
 * Flush queued Dock files to a ready primary renderer window.
 */
export function flushDockFileQueue(explicitWindow) {
    if (pendingFilePaths.length === 0)
        return false;
    const window = getReceivableWindow(explicitWindow);
    if (!window) {
        logger.info(`[Dock] No primary window ready; keeping ${pendingFilePaths.length} file(s) queued`);
        return false;
    }
    if (!isWindowReady(window)) {
        logger.info(`[Dock] Window ${window.id} is still loading; deferring ${pendingFilePaths.length} file(s)`);
        scheduleFlushWhenReady(window);
        return false;
    }
    if (!readyReceivers.has(window.webContents)) {
        logger.info(`[Dock] Waiting for file receiver in window ${window.id}`);
        return false;
    }
    const filePaths = pendingFilePaths;
    pendingFilePaths = [];
    pendingFilePathSet = new Set();
    logger.info(`[Dock] Flushing ${filePaths.length} Dock file(s) to renderer window ${window.id}`);
    const selectedFileTokens = captureSelectedFileIssuer(window.webContents)(filePaths);
    window.webContents.send(IPC_CHANNELS.DOCK_FILE_OPENED, {
        filePaths,
        ...(Object.keys(selectedFileTokens).length ? { selectedFileTokens } : {}),
    });
    return true;
}
export function getPendingDockFileCount() {
    return pendingFilePaths.length;
}
export function resetDockFileQueueForTest() {
    pendingFilePaths = [];
    pendingFilePathSet = new Set();
    getTargetWindow = null;
    registered = false;
    readyReceivers = new WeakSet();
    observedReceivers = new WeakSet();
    ipcMain.removeListener(IPC_CHANNELS.DOCK_FILE_RECEIVER_READY, onReceiverStateChanged);
    flushScheduledForWindowId = null;
    clearDeferredFlush();
}
