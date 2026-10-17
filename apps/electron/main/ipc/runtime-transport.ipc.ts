import { dialog, ipcMain } from "electron";
import { isDev, isInsideBuild, isStaging, isTest, isInternalBuild, buildEnv, isEn } from "../config/env";
import { IPC_CHANNELS } from "../config/constants";
import { getRuntimeTransportTargetMode, computeRuntimeTransportRelaunchArgs } from "../modules/menu/runtime-transport-menu";
import { isRuntimeProtocolTransportAllowed } from "../modules/local-runtime/utility/transport-mode";
function isRuntimeTransportMode(value) {
    return value === 'direct' || value === 'protocol';
}
function isRuntimeTransportDebugSupported(requestQuit) {
    return (Boolean(requestQuit) &&
        !isDev &&
        !isInsideBuild &&
        (isStaging || isTest || isInternalBuild) &&
        isRuntimeProtocolTransportAllowed({ buildEnv: buildEnv, isInternalBuild: isInternalBuild, isInsideBuild: isInsideBuild }));
}
async function confirmRuntimeTransportRestart(targetMode) {
    const { response } = await dialog.showMessageBox({
        type: 'question',
        message: targetMode === 'protocol'
            ? isEn
                ? 'Restart and enable the protocol debug transport?'
                : '重启并开启 Protocol 调试模式？'
            : isEn
                ? 'Restart and restore the default direct transport?'
                : '重启并恢复默认 direct 传输？',
        detail: targetMode === 'protocol'
            ? isEn
                ? 'Runtime requests will appear in the Chromium DevTools Network panel as app:// requests. This only applies to the next launch.'
                : '重启后 runtime 请求将以 app:// 形式出现在 Chromium DevTools Network 面板；仅对本次重启生效，下次正常启动自动恢复默认模式。'
            : isEn
                ? 'Runtime requests will return to the direct MessagePort transport.'
                : '重启后 runtime 请求恢复走默认的 MessagePort 直连链路。',
        buttons: [isEn ? 'Restart' : '重启', isEn ? 'Cancel' : '取消'],
        defaultId: 0,
        cancelId: 1,
    });
    return response === 0;
}
export function setupRuntimeTransportIPC(options) {
    const getCurrentState = () => ({
        mode: options.mode,
        supported: isRuntimeTransportDebugSupported(options.requestQuit),
    });
    ipcMain.handle(IPC_CHANNELS.RUNTIME_TRANSPORT_GET_CURRENT, getCurrentState);
    ipcMain.handle(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_SWITCH, async (_event, targetMode) => {
        if (!isRuntimeTransportMode(targetMode)) {
            return { success: false, error: 'invalid_mode' };
        }
        const requestQuit = options.requestQuit;
        if (!requestQuit || !isRuntimeTransportDebugSupported(requestQuit)) {
            return { success: false, error: 'unsupported_environment' };
        }
        if (targetMode !== getRuntimeTransportTargetMode(options.mode)) {
            return { success: false, error: 'stale_mode' };
        }
        if (!(await confirmRuntimeTransportRestart(targetMode))) {
            return { success: false, error: 'cancelled' };
        }
        try {
            const result = await requestQuit({
                kind: 'relaunch',
                source: 'runtime-transport-switch',
                options: {
                    args: computeRuntimeTransportRelaunchArgs(options.argv ?? process.argv.slice(1), targetMode),
                },
            });
            return result.status === 'accepted' && result.terminalOutcome === 'dispatched'
                ? { success: true }
                : { success: false, error: 'relaunch_failed' };
        }
        catch {
            return { success: false, error: 'relaunch_failed' };
        }
    });
}
