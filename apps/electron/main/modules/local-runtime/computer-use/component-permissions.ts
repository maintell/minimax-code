import { createComputerUseClient, discoverComponent } from "@mavis/computer-use";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { shell } from "electron";
import { prepareDesktopComputerUseComponent } from "./packaged-component";
const blocked = () => ({
    accessibility: 'restricted',
    screenRecording: 'restricted',
    captureReady: false,
});
function dataDir() {
    // Electron freezes this profile selection before registering the IPC bridge.
    const value = process.env.MINIMAX_DATA_DIR;
    if (!value || !path.isAbsolute(value))
        throw new Error('computer_profile_required');
    return value;
}
function validateKind(kind) {
    if (kind !== 'accessibility' && kind !== 'screen-recording') {
        throw new Error('computer_permission_kind_invalid');
    }
}
function snapshot(status) {
    if (!status.supported ||
        !status.componentVersion ||
        (status.code &&
            status.code !== 'computer_permission_required' &&
            status.code !== 'computer_capture_verification_required'))
        return blocked();
    if (process.platform === 'win32') {
        return status.granted
            ? { accessibility: 'not-required', screenRecording: 'not-required', captureReady: true }
            : blocked();
    }
    if (process.platform !== 'darwin')
        return blocked();
    return {
        accessibility: status.accessibility ? 'granted' : 'denied',
        screenRecording: status.screenRecording ? 'granted' : 'denied',
        captureReady: status.granted,
    };
}
/** User-initiated setup only. These clients never acquire a control session. */
async function inspect(request) {
    const profileDataDir = dataDir();
    const client = createComputerUseClient({
        dataDir: profileDataDir,
        ...(await prepareDesktopComputerUseComponent(profileDataDir)),
        ownerId: `desktop-permission-${randomUUID()}`,
        sdkRuntimeDirectory: __dirname,
    });
    try {
        return await (request ? client.requestPermissions() : client.getStatus());
    }
    finally {
        // A permission probe owns only its own daemon, never the control client's daemon.
        await client.close();
    }
}
export async function getComputerUsePermissionStatus() {
    try {
        return snapshot(await inspect(false));
    }
    catch {
        return blocked();
    }
}
export async function requestComputerUsePermission(kind) {
    validateKind(kind);
    try {
        const result = await inspect(true);
        const status = snapshot(result)[kind === 'accessibility' ? 'accessibility' : 'screenRecording'];
        return {
            status,
            message: result.message ??
                (status === 'granted' || status === 'not-required'
                    ? 'MiniMax Computer Use permission granted'
                    : 'Grant permissions to MiniMax Computer Use in System Settings.'),
        };
    }
    catch {
        return {
            status: 'restricted',
            message: 'MiniMax Computer Use is unavailable. Install a trusted matching component and try again.',
        };
    }
}
export async function getVerifiedComputerUseAppBundle() {
    if (process.platform !== 'darwin')
        return undefined;
    const profileDataDir = dataDir();
    const options = await prepareDesktopComputerUseComponent(profileDataDir);
    const component = options.resolveComponent
        ? await options.resolveComponent()
        : await discoverComponent({ dataDir: profileDataDir, ...options });
    return component.appBundle;
}
export async function openComputerUsePermissionSettings(kind) {
    validateKind(kind);
    if (process.platform !== 'darwin')
        return;
    // Opening settings must not prime Electron's separate screen-capture TCC entry.
    const pane = kind === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
}
