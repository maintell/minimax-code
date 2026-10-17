/**
 * Archon Chat Window IPC handlers
 * Handles switching between Archon and old main window,
 * and local runtime readiness checks.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { windowManager } from "../windows";
import { getLocalRuntimeFailReason, isLocalRuntimeReady, setLocalRuntimeRunawayGuardConfig, setLocalRuntimeToolResultCompactionConfig, setLocalRuntimeCollectionPolicyConfig, createLocalAsrNativeSession, parseLocalAsrNativeControlFrame } from "../modules/local-runtime";
import { connectRendererToUtilityRuntime, disconnectRendererFromUtilityRuntime } from "../modules/local-runtime/utility";
import { getDeviceInfo } from "../utils/device-info";
import { getCategoryLogger } from "../utils/logger";
import { setupUtilityRuntimeTransportIPC } from "./utility-runtime.ipc";
const logger = getCategoryLogger('archon');
const nativeAsrSessions = new Map();
function nativeAsrSessionKey(senderId, sessionId) {
    return `${String(senderId)}:${sessionId}`;
}
function readNativeAsrSessionId(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const sessionId = payload.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}
function readNativeAsrAudio(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const data = payload.data;
    if (Buffer.isBuffer(data))
        return data;
    if (data instanceof ArrayBuffer)
        return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}
/**
 * Setup Archon Chat Window IPC handlers
 */
export function setupArchonChatIPC(runtimeTransportMode) {
    /**
     * Check if local runtime backend is ready (renderer polls on mount)
     */
    const checkRuntimeReady = () => {
        const failReason = getLocalRuntimeFailReason();
        const ready = isLocalRuntimeReady();
        return {
            ready,
            failReason: failReason ?? undefined,
            // Include device info when not ready, for startup failure tracking
            ...(!ready ? { deviceInfo: getDeviceInfo() } : {}),
        };
    };
    ipcMain.handle(IPC_CHANNELS.RUNTIME_CHECK_READY, checkRuntimeReady);
    ipcMain.handle(IPC_CHANNELS.RUNTIME_SET_RUNAWAY_GUARD_CONFIG, (_event, config) => {
        setLocalRuntimeRunawayGuardConfig(config);
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_SET_TOOL_RESULT_COMPACTION_CONFIG, (_event, config) => {
        setLocalRuntimeToolResultCompactionConfig(config);
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_SET_COLLECTION_POLICY_CONFIG, (_event, config) => {
        // `applied: false` means the payload was rejected and the previously
        // effective policy is still in force — never an empty policy.
        return { success: true, applied: setLocalRuntimeCollectionPolicyConfig(config) };
    });
    /**
     * The renderer asks for a MessagePort into the always-on utility runtime.
     * The port itself arrives separately on RUNTIME_TRANSPORT_PORT_CHANNEL via
     * webContents.postMessage. A failed connection is reported as unavailable,
     * never as permission to select an in-process runtime.
     */
    setupUtilityRuntimeTransportIPC({
        mode: runtimeTransportMode,
        connectRenderer: connectRendererToUtilityRuntime,
        disconnectRenderer: disconnectRendererFromUtilityRuntime,
        warn: (message) => logger.warn(message),
    });
    ipcMain.handle(IPC_CHANNELS.LOCAL_ASR_SESSION_OPEN, (event, payload) => {
        const sessionId = readNativeAsrSessionId(payload);
        if (!sessionId)
            return { success: false, error: 'Invalid ASR session id' };
        const key = nativeAsrSessionKey(event.sender.id, sessionId);
        nativeAsrSessions.get(key)?.close();
        const sender = event.sender;
        const session = createLocalAsrNativeSession({
            isOpen: () => !sender.isDestroyed(),
            sendFrame: (frame) => {
                if (!sender.isDestroyed()) {
                    sender.send(IPC_CHANNELS.LOCAL_ASR_SESSION_EVENT, { sessionId, frame });
                }
            },
            close: (reason) => {
                nativeAsrSessions.delete(key);
                if (!sender.isDestroyed()) {
                    sender.send(IPC_CHANNELS.LOCAL_ASR_SESSION_CLOSED, { sessionId, reason });
                }
            },
        });
        nativeAsrSessions.set(key, session);
        sender.once('destroyed', () => {
            nativeAsrSessions.get(key)?.close();
            nativeAsrSessions.delete(key);
        });
        return { success: true };
    });
    ipcMain.on(IPC_CHANNELS.LOCAL_ASR_SESSION_FRAME, (event, payload) => {
        const sessionId = readNativeAsrSessionId(payload);
        if (!sessionId)
            return;
        const frame = parseLocalAsrNativeControlFrame(payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload.frame
            : undefined);
        if (!frame)
            return;
        nativeAsrSessions.get(nativeAsrSessionKey(event.sender.id, sessionId))?.receiveFrame(frame);
    });
    ipcMain.on(IPC_CHANNELS.LOCAL_ASR_SESSION_AUDIO, (event, payload) => {
        const sessionId = readNativeAsrSessionId(payload);
        if (!sessionId)
            return;
        const audio = readNativeAsrAudio(payload);
        if (!audio)
            return;
        nativeAsrSessions.get(nativeAsrSessionKey(event.sender.id, sessionId))?.receiveAudio(audio);
    });
    ipcMain.on(IPC_CHANNELS.LOCAL_ASR_SESSION_CLOSE, (event, payload) => {
        const sessionId = readNativeAsrSessionId(payload);
        if (!sessionId)
            return;
        const key = nativeAsrSessionKey(event.sender.id, sessionId);
        nativeAsrSessions.get(key)?.close();
        nativeAsrSessions.delete(key);
    });
    /**
     * Open the Archon Chat window (from old main → archon)
     */
    ipcMain.handle(IPC_CHANNELS.ARCHON_CHAT_OPEN, async () => {
        try {
            await windowManager.switchToArchonWindow();
            return { success: true };
        }
        catch (error) {
            console.error('[ArchonChat IPC] Failed to open window:', error);
            return { success: false, error: String(error) };
        }
    });
}
