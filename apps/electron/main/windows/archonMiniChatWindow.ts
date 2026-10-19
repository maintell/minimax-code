/**
 * Archon Mini Chat Window
 * Lightweight quick-input window for archon mode.
 */
import * as path from "path";
import { shell } from "electron";
import { IPC_CHANNELS, PAGE_URLS, isDev } from "../config";
import { waitForServer } from "../utils";
import { getWindowPositionForCurrentDisplay, DEFAULT_SECURE_WEB_PREFERENCES, registerTransparentWindow, shouldDenyWindowOpen } from "./utils";
import { createDesktopRendererWindow } from "./desktopRendererWindow";
let archonMiniChatWindow = null;
const keepVisibleOperations = new Set();
let ignoreMouseEvents = false;
const MINI_CHAT_TRANSPARENT_BACKGROUND_CSS = `
  html,
  body,
  #__next {
    background: transparent !important;
  }
`;
export function getArchonMiniChatWindow() {
    return archonMiniChatWindow;
}
/** Wait for native focus transfer before deciding whether the user left Mini Chat. */
export function scheduleArchonMiniChatBlur(ownerWindow) {
    if (!ownerWindow || ownerWindow !== archonMiniChatWindow)
        return;
    setImmediate(() => {
        if (ownerWindow !== archonMiniChatWindow ||
            ownerWindow.isDestroyed() ||
            ownerWindow.webContents.isDestroyed() ||
            !ownerWindow.isVisible() ||
            ownerWindow.isFocused() ||
            keepVisibleOperations.size > 0 ||
            ownerWindow
                .getChildWindows()
                .some((child) => !child.isDestroyed() && child.isVisible() && child.isFocused()))
            return;
        ownerWindow.webContents.send(IPC_CHANNELS.MINI_CHAT_BLUR);
    });
}
function applyIgnoreMouseEvents() {
    if (!archonMiniChatWindow || archonMiniChatWindow.isDestroyed())
        return;
    if (ignoreMouseEvents) {
        archonMiniChatWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    else {
        archonMiniChatWindow.setIgnoreMouseEvents(false);
    }
}
function resetIgnoreMouseEvents() {
    ignoreMouseEvents = false;
    applyIgnoreMouseEvents();
}
export function setArchonMiniChatIgnoreMouseEvents(ignore) {
    ignoreMouseEvents = ignore;
    applyIgnoreMouseEvents();
}
export async function runWhileKeepingMiniChatVisible(ownerWindow, operation) {
    const miniChatWindow = archonMiniChatWindow;
    if (!miniChatWindow || miniChatWindow.isDestroyed() || ownerWindow !== miniChatWindow) {
        return operation();
    }
    const operationId = Symbol('mini-chat-visible-operation');
    keepVisibleOperations.add(operationId);
    try {
        return await operation();
    }
    finally {
        if (!miniChatWindow.isDestroyed()) {
            miniChatWindow.show();
            miniChatWindow.focus();
            applyIgnoreMouseEvents();
        }
        setTimeout(() => {
            keepVisibleOperations.delete(operationId);
        }, 100);
    }
}
function buildArchonMiniChatUrl() {
    return PAGE_URLS.ARCHON_MINI_CHAT;
}
export async function createArchonMiniChatWindow() {
    if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
        const [width, height] = archonMiniChatWindow.getSize();
        const { x, y } = getWindowPositionForCurrentDisplay(width, height);
        archonMiniChatWindow.setPosition(x, y);
        archonMiniChatWindow.show();
        archonMiniChatWindow.focus();
        resetIgnoreMouseEvents();
        return;
    }
    const windowWidth = 600;
    const windowHeight = 400;
    const { x, y } = getWindowPositionForCurrentDisplay(windowWidth, windowHeight);
    archonMiniChatWindow = createDesktopRendererWindow('mini-chat', {
        width: windowWidth,
        height: windowHeight,
        x,
        y,
        minWidth: windowWidth,
        minHeight: windowHeight,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        fullscreen: false,
        title: 'Quick Input',
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: false,
        skipTaskbar: false,
        hasShadow: false,
        webPreferences: {
            ...DEFAULT_SECURE_WEB_PREFERENCES,
            scrollBounce: process.platform === 'darwin',
            preload: path.join(__dirname, '..', 'preload.js'),
            backgroundThrottling: false,
            offscreen: false,
        },
        show: false,
    });
    registerTransparentWindow(archonMiniChatWindow);
    archonMiniChatWindow.webContents.once('did-finish-load', async () => {
        const miniChatWindow = archonMiniChatWindow;
        if (!miniChatWindow || miniChatWindow.isDestroyed())
            return;
        resetIgnoreMouseEvents();
        try {
            await miniChatWindow.webContents.insertCSS(MINI_CHAT_TRANSPARENT_BACKGROUND_CSS);
        }
        catch (error) {
            console.warn('[ArchonMiniChat] Failed to enforce transparent background:', error);
        }
        setTimeout(() => {
            if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
                archonMiniChatWindow.show();
                archonMiniChatWindow.focus();
                resetIgnoreMouseEvents();
            }
        }, 100);
    });
    archonMiniChatWindow.webContents.on('did-fail-load', async (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[ArchonMiniChat] Failed to load: ${validatedURL}, Error: ${errorDescription} (${errorCode})`);
        if (isDev && errorCode !== -3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            archonMiniChatWindow?.loadURL(buildArchonMiniChatUrl());
        }
    });
    const url = buildArchonMiniChatUrl();
    if (isDev) {
        const serverReady = await waitForServer(PAGE_URLS.ARCHON_MINI_CHAT);
        if (serverReady) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            archonMiniChatWindow.loadURL(url);
        }
        else {
            console.error('[ArchonMiniChat] Failed to connect to Next.js server');
            archonMiniChatWindow.destroy();
            archonMiniChatWindow = null;
            return;
        }
    }
    else {
        archonMiniChatWindow.loadURL(url);
    }
    archonMiniChatWindow.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
        if (shouldDenyWindowOpen(linkUrl)) {
            shell.openExternal(linkUrl);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
    archonMiniChatWindow.on('closed', () => {
        archonMiniChatWindow = null;
        keepVisibleOperations.clear();
        ignoreMouseEvents = false;
    });
    archonMiniChatWindow.on('blur', () => {
        scheduleArchonMiniChatBlur(archonMiniChatWindow);
    });
    archonMiniChatWindow.on('focus', () => {
        if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
            archonMiniChatWindow.webContents.send(IPC_CHANNELS.MINI_CHAT_FOCUS);
        }
    });
    archonMiniChatWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyUp') {
            archonMiniChatWindow?.webContents.send(IPC_CHANNELS.ASR_PUSH_TO_TALK_KEY_UP, {
                key: input.key,
                code: input.code,
            });
        }
        if (input.type === 'keyDown' && input.key === 'Escape') {
            hideArchonMiniChatWindow();
        }
    });
}
export function closeArchonMiniChatWindow() {
    if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
        archonMiniChatWindow.close();
    }
}
export function showArchonMiniChatWindow() {
    if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
        const [width, height] = archonMiniChatWindow.getSize();
        const { x, y } = getWindowPositionForCurrentDisplay(width, height);
        archonMiniChatWindow.setPosition(x, y);
        archonMiniChatWindow.show();
        archonMiniChatWindow.focus();
        resetIgnoreMouseEvents();
    }
    else {
        createArchonMiniChatWindow();
    }
}
export function hideArchonMiniChatWindow() {
    if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
        resetIgnoreMouseEvents();
        archonMiniChatWindow.hide();
    }
}
export function toggleArchonMiniChatWindow() {
    if (archonMiniChatWindow &&
        !archonMiniChatWindow.isDestroyed() &&
        archonMiniChatWindow.isVisible()) {
        hideArchonMiniChatWindow();
    }
    else {
        showArchonMiniChatWindow();
    }
}
export function resizeArchonMiniChatWindow(height) {
    if (archonMiniChatWindow && !archonMiniChatWindow.isDestroyed()) {
        const [width, currentHeight] = archonMiniChatWindow.getSize();
        if (currentHeight === height)
            return;
        const [x, y] = archonMiniChatWindow.getPosition();
        const heightDiff = height - currentHeight;
        const newY = y - heightDiff;
        archonMiniChatWindow.setBounds({ x, y: newY, width, height }, true);
    }
}
