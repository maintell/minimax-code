import { RECORDING_FINALIZE_TIMEOUT_MS } from "./capture-contract";
import { screen, session, BrowserWindow, ipcMain, Menu, Tray, systemPreferences, desktopCapturer, nativeImage, clipboard, shell, app } from "electron";
import path from "node:path";
import { configureCaptureWindow, isOwnFrame } from "./capture-window";
import { getTrayIcon } from "../tray/icon";
import logger from "../../utils/logger";
import { unlink, open, writeFile } from "node:fs/promises";
import { createCapturePath } from "./capture-storage";
import { validateCaptureBytes } from "./media-validation";
import { validateCaptureArea, captureControlsBounds, createCaptureControls, capturePreviewBounds, validateCaptureProgress } from "./capture-controls";
import { createCaptureRegionMask } from "./capture-region-mask";
import { captureNativeDisplaySnapshot } from "./capture-native-snapshot";
import { attachCaptureRendererIncidentHandler } from "../../lifecycle/renderer-incident-controller";
let active = false;
let cancelActiveCapture;
let activeCaptureCompletion = Promise.resolve();
/** Called by the screenshots lifecycle module; waits for pending writes and deletion. */
export async function disposeCaptureSession() {
    cancelActiveCapture?.();
    await activeCaptureCompletion;
}
/** Notched MacBook panels: the notch is as tall as the menu bar (~38 DIP at default scaling). */
const MAC_INTERNAL_SAFE_TOP = 38;
/**
 * Overlay height (DIP) hidden by the menu bar or notch. The work area covers the
 * visible menu bar; internal Mac panels also keep a notch-sized inset when the
 * menu bar auto-hides, because Electron exposes no notch geometry.
 */
export function captureSafeTop(display) {
    const menuBar = display.workArea ? display.workArea.y - display.bounds.y : 0;
    const notch = process.platform === 'darwin' && display.internal ? MAC_INTERNAL_SAFE_TOP : 0;
    return Math.max(0, Math.round(menuBar), notch);
}
/** Each capture owns its isolated session, source inventory, IPC and renderer lifetime. */
export async function startCaptureSession(owner, locale = 'zh', onMode) {
    if (active)
        throw new Error('A capture is already in progress');
    active = true;
    try {
        const completion = runSession(owner, locale, onMode);
        activeCaptureCompletion = completion.then(() => undefined, () => undefined);
        return await completion;
    }
    finally {
        active = false;
        cancelActiveCapture = undefined;
    }
}
async function runSession(owner, locale, onMode) {
    // Resolve once, before the overlay can change focus or the pointer moves.
    logger.info('[Screenshot] Resolving display');
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    logger.info('[Screenshot] Creating capture session');
    const captureSession = session.fromPartition('screen-capture');
    logger.info('[Screenshot] Creating capture window');
    const win = new BrowserWindow({
        ...display.bounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        roundedCorners: false,
        paintWhenInitiallyHidden: true,
        enableLargerThanScreen: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        show: false,
        title: 'Screen capture',
        webPreferences: {
            preload: path.join(__dirname, 'capture-preload.js'),
            session: captureSession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    const contents = win.webContents;
    // Do not rely on content protection for macOS ScreenCaptureKit: hide before capture.
    logger.info('[Screenshot] Configuring capture window');
    configureCaptureWindow(win);
    win.setBounds(display.bounds);
    let selected;
    let initializing = false;
    let initialized = false;
    let settled = false;
    let saving = false;
    let recording;
    let recordingPath;
    let recordedBytes = 0;
    let writes = Promise.resolve();
    let imageWrite = Promise.resolve();
    const snapshotAbort = new AbortController();
    let nativeSnapshotTask = Promise.resolve(null);
    let imagePath;
    let controls;
    let regionMask;
    let capturing = false;
    let ready = false;
    let pendingArea;
    let shutdownTimer;
    let finishing = false;
    let captureStatus;
    let tray;
    let trayTimer;
    let trayMenuKey = '';
    let stateTimer;
    let captureMode = 'scroll';
    let paused = false;
    let elapsedBefore = 0;
    let resumedAt = 0;
    const channels = [];
    let detachIncidentHandler;
    let startupTimer;
    return new Promise((resolve, reject) => {
        /** Release the region mask, the control bar, the tray. */
        const resetCaptureUi = () => {
            regionMask?.dispose();
            controls?.dispose();
            controls = undefined;
            clearInterval(trayTimer);
            clearInterval(stateTimer);
            tray?.destroy();
            tray = undefined;
        };
        const end = (error, result, preserveRecording = false) => {
            if (settled)
                return;
            logger.info('[Screenshot] Capture ended', {
                initialized,
                visible: !win.isDestroyed() && win.isVisible(),
                reason: error?.message ?? 'saved',
            });
            settled = true;
            clearTimeout(startupTimer);
            clearTimeout(shutdownTimer);
            snapshotAbort.abort();
            contents.removeListener('preload-error', onPreloadError);
            for (const channel of channels)
                ipcMain.removeHandler(channel);
            owner.removeListener('destroyed', ownerStopped);
            owner.removeListener('did-start-navigation', ownerNavigated);
            detachIncidentHandler?.();
            captureSession.setDisplayMediaRequestHandler(null);
            captureSession.setPermissionCheckHandler(() => false);
            captureSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
            if (!win.isDestroyed())
                win.destroy();
            capturing = false;
            resetCaptureUi();
            void Promise.allSettled([writes, imageWrite, nativeSnapshotTask]).then(async () => {
                await recording?.close().catch(() => undefined);
                if (error && recordingPath && !preserveRecording)
                    await unlink(recordingPath).catch(() => undefined);
                if (error && imagePath)
                    await unlink(imagePath).catch(() => undefined);
                if (error)
                    reject(error);
                else if (result)
                    resolve(result);
                else
                    reject(new Error('Capture ended without a result'));
            });
        };
        const cancel = () => end(new Error('Screenshot cancelled'));
        function interrupt(error) {
            error.name = 'CaptureInterruptedError';
            end(error, undefined, ready && captureMode === 'record');
        }
        // Flush the encoder before its owner or the app goes away. If the capture
        // process stops responding, retain the fragments it already wrote for recovery.
        function ownerStopped() {
            if (settled || shutdownTimer)
                return;
            if (!ready || captureMode !== 'record')
                return interrupt(new Error('Screenshot cancelled'));
            shutdownTimer = setTimeout(() => interrupt(new Error('Recording finalization timed out')), RECORDING_FINALIZE_TIMEOUT_MS);
            onControlAction('finish');
        }
        const ownerNavigated = (_event, _url, isInPlace, isMainFrame) => {
            // Subframe loads (widgets, previews) and in-page history changes keep the composer alive.
            if (!isMainFrame || isInPlace)
                return;
            logger.info('[Screenshot] Owner navigated');
            ownerStopped();
        };
        const elapsed = () => (paused ? elapsedBefore : elapsedBefore + Date.now() - resumedAt);
        const publishRecordingState = () => {
            if (settled || !capturing || captureMode !== 'record')
                return;
            controls?.state({ elapsedMs: elapsed(), paused });
        };
        const updateTray = () => {
            if (settled || !capturing || !tray)
                return;
            const en = locale === 'en';
            const seconds = Math.floor(elapsed() / 1000);
            const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
            const label = captureStatus ||
                (captureMode === 'record'
                    ? `${en ? 'Recording' : '录屏中'} ${time}`
                    : en
                        ? 'Scrolling screenshot in progress'
                        : '滚动截图中');
            tray.setToolTip(label);
            // Rebuilding the native menu is expensive; only the label and the pause state change.
            const menuKey = `${label}|${paused}`;
            if (menuKey === trayMenuKey)
                return;
            trayMenuKey = menuKey;
            tray.setContextMenu(Menu.buildFromTemplate([
                { label, enabled: false },
                ...(captureMode === 'record'
                    ? [
                        {
                            label: paused ? (en ? 'Resume' : '继续') : en ? 'Pause' : '暂停',
                            click: () => onControlAction('pause'),
                        },
                    ]
                    : []),
                { label: en ? 'Finish and save' : '完成并保存', click: () => onControlAction('finish') },
                ...(captureMode === 'scroll'
                    ? [{ label: en ? 'Cancel' : '取消', click: () => onControlAction('cancel') }]
                    : []),
            ]));
        };
        function onControlAction(action) {
            if (settled || saving || !ready || finishing)
                return;
            if (action === 'cancel')
                cancel();
            else if (action === 'finish') {
                finishing = true;
                regionMask?.dispose();
                controls?.dispose();
                contents.send('capture:finish');
            }
            else if (captureMode === 'record') {
                if (paused)
                    resumedAt = Date.now();
                else
                    elapsedBefore += Date.now() - resumedAt;
                paused = !paused;
                contents.send('capture:pause', paused);
                publishRecordingState();
                updateTray();
            }
        }
        const showTrayFallback = () => {
            if (settled || !capturing || tray)
                return;
            controls = undefined;
            try {
                tray = new Tray(getTrayIcon());
            }
            catch (error) {
                logger.info('[Screenshot] Tray fallback unavailable', {
                    reason: error instanceof Error ? error.message : String(error),
                });
                interrupt(new Error('Capture controls are unavailable'));
                return;
            }
            updateTray();
            trayTimer = setInterval(updateTray, 1000);
        };
        const onPreloadError = (_event, _preloadPath, error) => end(error);
        contents.on('preload-error', onPreloadError);
        // Capture diagnostics (stream size etc.) are tagged by the renderer; nothing else is forwarded.
        contents.on('console-message', (details) => {
            const message = typeof details?.message === 'string' ? details.message : '';
            if (message.startsWith('[capture] '))
                logger.info('[Screenshot] ' + message.slice(10, 400));
        });
        startupTimer = setTimeout(() => end(new Error('Capture initialization timed out')), 15000);
        const handle = (channel, callback) => {
            channels.push(channel);
            ipcMain.handle(channel, (event, ...args) => {
                if (settled || !isOwnFrame(event, win)) {
                    throw new Error('Unauthorized capture caller');
                }
                return callback(...args);
            });
        };
        captureSession.setPermissionCheckHandler((wc, permission) => wc === contents && ['media', 'display-capture'].includes(permission));
        captureSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
            if (wc !== contents || permission !== 'media')
                return callback(false);
            // Electron lists only the microphone ("audio") and camera ("video"); screen requests, both
            // getDisplayMedia and the pinned desktop getUserMedia, arrive without media types. Grant
            // those only for the selected screen while the overlay is off screen; never the camera.
            const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
            if (types.length === 0)
                return callback(!settled && !!selected && !win.isDestroyed() && !win.isVisible());
            if (!types.every((type) => type === 'audio'))
                return callback(false);
            callback(process.platform !== 'darwin' || (await systemPreferences.askForMediaAccess('microphone')));
        });
        captureSession.setDisplayMediaRequestHandler((request, callback) => {
            if (settled || !selected || request.frame !== contents.mainFrame)
                return callback({});
            callback({ video: selected });
        });
        handle('capture:locale', () => locale);
        // Checked when the user turns the microphone on, so a refusal never interrupts a recording.
        handle('capture:microphone', async () => {
            if (typeof systemPreferences.getMediaAccessStatus !== 'function')
                return 'granted';
            const status = systemPreferences.getMediaAccessStatus('microphone');
            if (status === 'granted')
                return 'granted';
            // Windows reports its privacy switch; anything but a refusal is left to getUserMedia.
            if (process.platform !== 'darwin')
                return status === 'denied' ? 'denied' : 'granted';
            if (status !== 'not-determined')
                return 'denied';
            // The screen-saver level overlay would cover the macOS prompt; step down while it is open.
            win.setAlwaysOnTop(false);
            try {
                return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
            }
            finally {
                if (!win.isDestroyed())
                    win.setAlwaysOnTop(true, 'screen-saver');
            }
        });
        handle('capture:error', (message) => end(new Error(typeof message === 'string' ? message.slice(0, 1000) : 'Capture failed')));
        handle('capture:show', () => {
            if (!initialized)
                throw new Error('Capture is not initialized');
            clearTimeout(startupTimer);
            capturing = ready = finishing = false;
            onMode?.('unknown');
            pendingArea = undefined;
            resetCaptureUi();
            if (!win.isDestroyed())
                win.show();
        });
        handle('capture:initialize', async () => {
            if (initializing || initialized)
                throw new Error('Capture is already initialized');
            initializing = true;
            // The overlay is still hidden here, so both captures see only the user's windows.
            nativeSnapshotTask = captureNativeDisplaySnapshot(display, snapshotAbort.signal);
            const [inventory, nativeSnapshot] = await Promise.all([
                desktopCapturer.getSources({
                    types: ['screen'],
                    thumbnailSize: {
                        width: Math.round(display.bounds.width * display.scaleFactor),
                        height: Math.round(display.bounds.height * display.scaleFactor),
                    },
                }),
                nativeSnapshotTask,
            ]);
            if (settled)
                throw new Error('Capture cancelled');
            const source = inventory.find((item) => item.display_id === String(display.id));
            // A missing preview is not a missing source: the renderer can decode a live frame.
            logger.info('[Screenshot] Display source resolved', {
                displayId: display.id,
                sourceCount: inventory.length,
                sources: inventory.map((item) => ({
                    id: item.id,
                    displayId: item.display_id,
                    thumbnailEmpty: item.thumbnail.isEmpty(),
                })),
                code: !source
                    ? 'capture_display_not_found'
                    : source.thumbnail.isEmpty()
                        ? 'capture_thumbnail_empty'
                        : 'capture_thumbnail_ready',
                snapshot: nativeSnapshot ? 'native' : 'thumbnail',
            });
            // Never silently use a different monitor when Chromium cannot identify this display.
            if (!source)
                throw new Error('Current display source was not found (capture_display_not_found)');
            selected = source;
            initialized = true;
            return {
                id: source.id,
                // Prefer the native frame: it keeps window shadows that ScreenCaptureKit drops.
                image: nativeSnapshot ?? (source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL()),
                width: Math.round(display.bounds.width * display.scaleFactor),
                height: Math.round(display.bounds.height * display.scaleFactor),
                safeTop: captureSafeTop(display),
            };
        });
        handle('capture:hide', async (options) => {
            const area = validateCaptureArea(options);
            if (!selected)
                throw new Error('No selected source');
            if (capturing)
                throw new Error('Capture is already hidden or starting');
            pendingArea = area;
            onMode?.(area.mode);
            win.hide();
            capturing = true;
            captureStatus = undefined;
            captureMode = area.mode;
            paused = false;
            elapsedBefore = 0;
            try {
                regionMask = createCaptureRegionMask(display.bounds, area.region, area.mode, interrupt);
            }
            catch (error) {
                end(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            await regionMask.ready;
            // Give the compositor time to remove the hidden overlay, including full-display crops
            // with no mask windows. A decoded video frame alone can still contain the old overlay.
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        handle('capture:started', () => {
            const area = pendingArea;
            if (!capturing || !area || ready)
                throw new Error('Capture is not starting');
            pendingArea = undefined;
            ready = true;
            resumedAt = Date.now();
            const workArea = display.workArea ?? display.bounds;
            const bounds = captureControlsBounds(display.bounds, area.region, area.mode, workArea);
            if (bounds)
                controls = createCaptureControls(bounds, locale, area.mode, onControlAction, showTrayFallback, area.mode === 'scroll'
                    ? capturePreviewBounds(display.bounds, area.region, workArea, bounds)
                    : undefined);
            else
                showTrayFallback();
            if (!settled && area.mode === 'record') {
                publishRecordingState();
                stateTimer = setInterval(publishRecordingState, 500);
            }
        });
        handle('capture:progress', (value) => {
            const progress = validateCaptureProgress(value);
            if (!capturing || saving)
                return;
            captureStatus = progress.status;
            controls?.update(progress);
            updateTray();
        });
        handle('capture:chunk', (data) => {
            if (!selected ||
                saving ||
                !(data instanceof ArrayBuffer) ||
                data.byteLength > 16 * 1024 * 1024)
                throw new Error('Invalid recording chunk');
            recordedBytes += data.byteLength;
            if (recordedBytes > 2 * 1024 * 1024 * 1024 - 32 * 1024 * 1024)
                contents.send('capture:finish');
            writes = writes.then(async () => {
                if (settled)
                    throw new Error('Capture cancelled');
                if (!recording) {
                    recordingPath = await createCapturePath('recording');
                    recording = await open(recordingPath, 'wx+', 0o600);
                }
                await recording.writeFile(Buffer.from(data));
            });
            return writes;
        });
        handle('capture:complete', async () => {
            if (saving)
                throw new Error('Capture is already finishing');
            saving = true;
            regionMask?.dispose();
            controls?.dispose();
            try {
                await writes;
                if (!recording || !recordingPath)
                    throw new Error('Recording is empty');
                const header = Buffer.alloc(64);
                const { bytesRead } = await recording.read(header, 0, header.length, 0);
                validateCaptureBytes(header.subarray(0, bytesRead), 'video/mp4');
                await recording.sync();
                end(undefined, { filePath: recordingPath, mimeType: 'video/mp4' });
            }
            catch (error) {
                end(error instanceof Error ? error : new Error(String(error)));
            }
        });
        handle('capture:save', async (data, mime, keep = false) => {
            if (saving || !(data instanceof ArrayBuffer) || typeof keep !== 'boolean')
                throw new Error('Invalid capture data');
            saving = true;
            regionMask?.dispose();
            controls?.dispose();
            try {
                const bytes = Buffer.from(data);
                const extension = validateCaptureBytes(bytes, mime);
                onMode?.(extension === 'mp4'
                    ? 'record'
                    : capturing && captureMode === 'scroll'
                        ? 'scroll'
                        : 'image');
                const image = extension === 'png' ? nativeImage.createFromBuffer(bytes) : undefined;
                if (image?.isEmpty())
                    throw new Error('Captured image could not be decoded');
                const filePath = await createCapturePath(extension === 'png' ? (keep ? 'saved-image' : 'screenshot') : 'recording');
                if (settled)
                    return;
                imagePath = filePath;
                imageWrite = writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
                await imageWrite;
                if (!settled) {
                    if (image)
                        clipboard.writeImage(image);
                    end(undefined, { filePath, mimeType: extension === 'png' ? 'image/png' : 'video/mp4' });
                    if (keep)
                        shell.showItemInFolder(filePath);
                }
            }
            catch (error) {
                end(error instanceof Error ? error : new Error(String(error)));
            }
        });
        handle('capture:cancel', cancel);
        owner.once('destroyed', ownerStopped);
        owner.on('did-start-navigation', ownerNavigated);
        cancelActiveCapture = ownerStopped;
        win.on('close', (event) => {
            if (settled || !ready || captureMode !== 'record')
                return;
            event.preventDefault();
            ownerStopped();
        });
        win.once('closed', () => interrupt(new Error('Screenshot cancelled')));
        detachIncidentHandler = attachCaptureRendererIncidentHandler(win, interrupt);
        win
            .loadFile(path.join(app.getAppPath(), 'dist', 'capture', 'index.html'))
            .catch((error) => end(error));
    });
}
