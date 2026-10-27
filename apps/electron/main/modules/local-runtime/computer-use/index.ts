import { CuaDesktopOverlay } from "./cua-overlay";
import { CuaWindowHandoff } from "./cua-window-handoff";
import { clearCuaPreviewTargets, releaseCuaPreviewTarget, publishCuaPreviewTarget } from "./cua-preview";
/**
 * Main-process facade for the isolated CUA utility process.
 *
 * This module owns only Computer Use concerns: the CUA child lifecycle,
 * control/runtime MessagePorts and the lease release signal.
 * The ordinary local-runtime utility remains responsible for its own process
 * and receives a narrow channel callback from this facade.
 */
import path from "node:path";
import { createCuaOutputBuffer } from "./cua-output-buffer";
import { isDev } from "../../../config";
import { getCategoryLogger } from "../../../utils/logger";
const logger = getCategoryLogger('main', 'computer-use');
import { setComputerUseActive } from "../../power";
import { readCuaDisplays } from "./cua-displays";
let cuaStartPromise = null;
let cuaRuntimePort = null;
let cuaControlPort = null;
let cuaChild = null;
let cuaGeneration = 0;
let cuaActiveRequestCount = 0;
const windowHandoff = new CuaWindowHandoff(async () => {
    const { getMainWindow } = await import('../../../windows/mainWindow');
    return getMainWindow();
}, process.platform, (error) => logger.warn('computer_use_window_handoff_failed', { errorMessage: String(error) }));
const desktopOverlay = new CuaDesktopOverlay((turn) => windowHandoff.stop(turn, async () => {
    const { sessionId, turnId } = turn;
    const { handleLocalRuntimeRequest } = await import('..');
    const response = await handleLocalRuntimeRequest(new Request(`http://127.0.0.1/minimax-desktop/api/v1/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(turnId ? { turn_id: turnId } : {}), reason: 'user_stop' }),
        signal: AbortSignal.timeout(10000),
    }));
    if (!response.ok || (await response.json()).success !== true)
        throw new Error('computer_conversation_abort_failed');
}));
export function resetComputerUseRuntimeForTests() {
    clearCuaUtilityState();
    cuaStartPromise = null;
    cuaGeneration = 0;
}
export function releaseComputerUseLease(sessionId) {
    cuaChild?.postMessage({ type: 'cua-release', ...(sessionId ? { sessionId } : {}) });
}
/**
 * Returns a one-shot channel for local-runtime-v2. The runtime port is
 * consumed by the handoff; when local-runtime is already ready, a fresh pair
 * is created over the persistent CUA control port.
 */
export function takeComputerUseChannel() {
    const port = cuaRuntimePort ??
        (cuaControlPort ? createCuaRuntimeChannel(cuaControlPort, cuaGeneration) : null);
    cuaRuntimePort = null;
    return port ? { port, transfer: port, generation: cuaGeneration } : undefined;
}
export function attachPendingComputerUseChannel(host) {
    const channel = cuaRuntimePort;
    if (!channel)
        return true;
    if (!host.canAcceptRuntimeChannel())
        return true;
    logger.info(`[CuaUtility] handing off runtime channel generation=${cuaGeneration}`);
    cuaRuntimePort = null;
    if (!host.connectRuntimeChannel({ transfer: channel, generation: cuaGeneration })) {
        channel.close();
        // A failed hand-off must invalidate the live child/control markers as
        // well; otherwise subsequent activations would use an unavailable client.
        clearCuaUtilityState();
        return false;
    }
    logger.info(`[CuaUtility] runtime channel handed off generation=${cuaGeneration}`);
    return true;
}
/** Lazily starts the sibling CUA utility after an explicit Computer Use opt-in. */
export async function ensureComputerUseUtilityStarted(host) {
    try {
        await ensureCuaUtilityStarted();
        if (cuaRuntimePort &&
            host.canAcceptRuntimeChannel() &&
            !attachPendingComputerUseChannel(host)) {
            return false;
        }
        return true;
    }
    catch (error) {
        logger.warn(`[CuaUtility] startup unavailable; continuing without Computer Use: ${error instanceof Error ? error.message : String(error)}`);
        clearCuaUtilityState();
        return false;
    }
}
export function stopComputerUseUtility() {
    clearCuaUtilityState();
}
function clearCuaUtilityState() {
    windowHandoff.clear();
    clearCuaPreviewTargets();
    desktopOverlay.clear();
    updateCuaActivity(0);
    cuaRuntimePort?.close();
    cuaRuntimePort = null;
    const child = cuaChild;
    cuaChild = null;
    try {
        // The bridge retains its owned daemon and desktop lock until native work drains.
        cuaControlPort?.postMessage({ type: 'cua-shutdown' });
    }
    catch {
        logger.warn('[CuaUtility] shutdown delivery failed; native completion is unconfirmed');
    }
    cuaControlPort?.close();
    cuaControlPort = null;
    if (child) {
        const timer = setTimeout(() => {
            logger.warn('[CuaUtility] shutdown is still draining; not killing an unconfirmed native action');
        }, 10000);
        timer.unref();
        child.once('exit', () => clearTimeout(timer));
    }
}
async function ensureCuaUtilityStarted() {
    // `cuaRuntimePort` is transferred to local-runtime once that process is
    // ready, so the child and control port are the live lifecycle markers.
    if (cuaStartPromise) {
        if (isDev)
            logger.info('[CuaUtility] joining in-flight startup');
        return cuaStartPromise;
    }
    if (cuaChild && cuaControlPort) {
        if (isDev)
            logger.info(`[CuaUtility] already running generation=${cuaGeneration} pid=${cuaChild.pid ?? 'unknown'}`);
        return;
    }
    cuaStartPromise = (async () => {
        const electron = await import('electron');
        const channel = new electron.MessageChannelMain();
        const generation = ++cuaGeneration;
        const child = electron.utilityProcess.fork(path.join(__dirname, 'cua-entry.js'), [], {
            serviceName: 'mavis-cua',
            // This child is a protocol/presentation bridge; the branded App owns native UI work.
            env: {
                ...process.env,
                MAVIS_CUA_GENERATION: String(generation),
                MAVIS_CUA_DIAGNOSTICS: isDev ? '1' : '0',
            },
            stdio: 'pipe',
        });
        let childPid = child.pid;
        child.once('spawn', () => {
            childPid = child.pid;
        });
        cuaChild = child;
        cuaControlPort = channel.port2;
        logger.info(`[CuaUtility] forked generation=${generation} pid=${child.pid ?? 'unknown'}`);
        // Utility logs are newline-delimited structured records. Electron's
        // `data` events are arbitrary chunks (and may split UTF-8 sequences or a
        // single JSON record), so buffering by chunk loses the actual startup
        // error and can make the failure look like a generic `Error`. Keep the
        // pipes drained continuously while preserving complete lines.
        const attachOutputLogger = (stream, level) => {
            if (!stream)
                return () => undefined;
            const output = createCuaOutputBuffer((line) => logger[level]('utility_output', {
                stream: level === 'info' ? 'stdout' : 'stderr',
                output: line,
            }));
            stream.on('data', (chunk) => output.write(chunk));
            return () => output.end();
        };
        const flushStdout = attachOutputLogger(child.stdout, 'info');
        const flushStderr = attachOutputLogger(child.stderr, 'warn');
        let outputFlushed = false;
        const flushOutput = () => {
            if (outputFlushed)
                return;
            outputFlushed = true;
            flushStdout();
            flushStderr();
        };
        channel.port2.on('message', ({ data }) => {
            const message = data;
            if (!['cua-displays-request', 'cua-permission-required'].includes(message?.type ?? '') ||
                message?.generation !== generation ||
                cuaChild !== child)
                return;
            if (message.type === 'cua-permission-required') {
                clearCuaPreviewTargets();
                for (const window of electron.BrowserWindow.getAllWindows()) {
                    if (!window.isDestroyed())
                        window.webContents.send('cu:permission:required');
                }
                return;
            }
            const requestId = message.requestId;
            if (typeof requestId !== 'string')
                return;
            let response;
            try {
                response = { result: readCuaDisplays(electron.screen) };
            }
            catch {
                response = { error: 'computer_display_read_failed' };
            }
            channel.port2.postMessage({
                type: 'cua-displays-response',
                generation,
                requestId,
                ...response,
            });
        });
        channel.port2.start();
        const clearCuaState = (detail) => {
            logger.warn(`[CuaUtility] child lifecycle ended generation=${generation} pid=${childPid ?? 'unknown'}`, {
                exitCode: typeof detail === 'number' ? detail : undefined,
                error: detail instanceof Error ? detail.message : undefined,
            });
            flushOutput();
            if (cuaChild !== child)
                return;
            windowHandoff.clear();
            desktopOverlay.clear();
            updateCuaActivity(0);
            cuaRuntimePort?.close();
            cuaRuntimePort = null;
            cuaControlPort?.close();
            cuaControlPort = null;
            cuaChild = null;
            clearCuaPreviewTargets();
            logger.warn('[CuaUtility] utility exited; next computer-use activation will restart it');
        };
        child.once('exit', clearCuaState);
        child.once('error', clearCuaState);
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                flushOutput();
                clearCuaUtilityState();
                reject(new Error('computer_utility_start_timeout'));
            }, 30000);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once('exit', () => {
                clearTimeout(timer);
                reject(new Error('computer_utility_exited_before_ready'));
            });
            child.on('message', (message) => {
                const controlMessage = message;
                if (!controlMessage || controlMessage.generation !== generation || cuaChild !== child)
                    return;
                if ((controlMessage.type === 'cua-operation' ||
                    controlMessage.type === 'cua-operation-finished') &&
                    typeof controlMessage.sessionId === 'string' &&
                    typeof controlMessage.requestId === 'string') {
                    const turn = {
                        sessionId: controlMessage.sessionId,
                        turnId: controlMessage.turnId,
                    };
                    if (controlMessage.type === 'cua-operation-finished') {
                        desktopOverlay.finish(turn, controlMessage.requestId);
                    }
                    else {
                        desktopOverlay.show(turn, controlMessage.requestId);
                        void windowHandoff.begin(turn);
                    }
                    return;
                }
                if (controlMessage.type === 'cua-released') {
                    releaseCuaPreviewTarget(controlMessage.sessionId, controlMessage.turnId);
                    windowHandoff.release(controlMessage.sessionId, controlMessage.turnId);
                    desktopOverlay.clear(controlMessage.sessionId, controlMessage.turnId);
                    return;
                }
                if (controlMessage.type === 'cua-preview-target' && controlMessage.target) {
                    publishCuaPreviewTarget(controlMessage.target);
                    return;
                }
                if (controlMessage.type === 'cua-activity') {
                    const count = controlMessage.activeRequestCount;
                    if (Number.isSafeInteger(count) && Number(count) >= 0)
                        updateCuaActivity(Number(count));
                    return;
                }
                if (controlMessage.type === 'cua-ready') {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
        try {
            child.postMessage({ type: 'cua-connect', generation }, [channel.port1]);
        }
        catch (error) {
            flushOutput();
            clearCuaUtilityState();
            throw error;
        }
        await ready;
        cuaRuntimePort = createCuaRuntimeChannel(channel.port2, generation, electron);
    })().finally(() => {
        cuaStartPromise = null;
    });
    return cuaStartPromise;
}
function updateCuaActivity(activeRequestCount) {
    desktopOverlay.noteDriverActivity(activeRequestCount > 0);
    if (cuaActiveRequestCount === activeRequestCount)
        return;
    cuaActiveRequestCount = activeRequestCount;
    setComputerUseActive(activeRequestCount > 0);
}
function createCuaRuntimeChannel(controlPort, generation, electronModule) {
    const electron = electronModule ??
        require('electron');
    const runtimeChannel = new electron.MessageChannelMain();
    controlPort.postMessage({ type: 'cua-runtime-connect', generation }, [runtimeChannel.port1]);
    return runtimeChannel.port2;
}
