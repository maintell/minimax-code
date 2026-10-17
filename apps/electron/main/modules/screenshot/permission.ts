/**
 * Screen Recording Permission Utilities
 *
 * Cross-platform permission detection for macOS TCC screen recording gate.
 * Used by the Computer Use (CU) permission IPC bridge.
 */
import { systemPreferences, desktopCapturer, shell } from "electron";
import { getCategoryLogger } from "../../utils/logger";
const log = getCategoryLogger('main');
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const PERMISSION_PROBE_THUMBNAIL_SIZE = { width: 150, height: 150 };
/**
 * Get the current screen recording permission status.
 * Cross-platform: macOS checks TCC, Windows/Linux always returns 'not-required'.
 */
export function getScreenPermissionStatus() {
    if (process.platform !== 'darwin')
        return 'not-required';
    if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') {
        // macOS still requires TCC authorization even when this Electron build
        // cannot expose the status API. Treat the unknown capability as blocked;
        // `not-required` would incorrectly authorize physical screen reads.
        return 'restricted';
    }
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted')
        return 'granted';
    if (status === 'denied')
        return 'denied';
    if (status === 'restricted')
        return 'restricted';
    return 'not-determined';
}
/**
 * Electron exposes Accessibility as a trusted/not-trusted boolean rather than
 * a full TCC state. `false` is intentionally reported as `not-determined`:
 * only `true` is authoritative enough to enable Computer Use.
 */
export function getAccessibilityPermissionStatus() {
    if (process.platform !== 'darwin')
        return 'not-required';
    if (!systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') {
        return 'restricted';
    }
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not-determined';
}
export function getComputerUsePermissionStatus() {
    return {
        screenRecording: getScreenPermissionStatus(),
        accessibility: getAccessibilityPermissionStatus(),
    };
}
/**
 * Ask Chromium/Electron to perform a real screen-capture probe so macOS TCC
 * creates or refreshes this app's Screen Recording entry before we deep-link
 * the user to System Settings. A pure settings deep-link cannot add the app to
 * the list by itself.
 */
async function primeScreenRecordingTccRecord() {
    await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: PERMISSION_PROBE_THUMBNAIL_SIZE,
    });
}
/**
 * Request screen recording permission (macOS only).
 *
 * macOS does NOT support programmatic `askForMediaAccess('screen')`.
 * The only way to trigger the native permission dialog is to call
 * `desktopCapturer.getSources()` — if status is 'not-determined',
 * macOS will show the system prompt automatically.
 *
 * Returns the new permission status after the attempt.
 */
export async function requestScreenPermission() {
    if (process.platform !== 'darwin') {
        return {
            status: 'not-required',
            message: 'Screen recording permission is not required on this platform',
        };
    }
    const current = getScreenPermissionStatus();
    if (current === 'granted') {
        return { status: 'granted', message: 'Permission already granted' };
    }
    if (current === 'restricted') {
        return {
            status: 'restricted',
            message: 'Screen recording is restricted on this device (managed device or parental controls)',
        };
    }
    if (current === 'denied') {
        log.info('[Screenshot] Priming macOS screen recording TCC record before opening settings');
        try {
            await primeScreenRecordingTccRecord();
            const updated = getScreenPermissionStatus();
            if (updated === 'granted') {
                return { status: 'granted', message: 'Permission granted' };
            }
        }
        catch (err) {
            log.warn(`[Screenshot] Failed to prime screen recording TCC record: ${err}`);
        }
        openScreenRecordingSettings();
        return {
            status: 'denied',
            message: 'Permission was previously denied. Please enable screen recording in System Settings → Privacy & Security → Screen Recording, then try again.',
        };
    }
    // not-determined — trigger the system prompt via desktopCapturer
    log.info('[Screenshot] Triggering macOS screen recording permission dialog');
    try {
        await primeScreenRecordingTccRecord();
    }
    catch (err) {
        log.warn(`[Screenshot] desktopCapturer.getSources failed during permission request: ${err}`);
        openScreenRecordingSettings();
        return {
            status: 'not-determined',
            message: 'Could not trigger permission dialog. Opened System Settings instead.',
        };
    }
    const updated = getScreenPermissionStatus();
    if (updated === 'granted') {
        return { status: 'granted', message: 'Permission granted' };
    }
    openScreenRecordingSettings();
    return {
        status: updated,
        message: 'Permission not granted. Please enable screen recording in System Settings → Privacy & Security → Screen Recording.',
    };
}
/** Request the macOS Accessibility TCC grant through Electron. */
export async function requestAccessibilityPermission() {
    if (process.platform !== 'darwin') {
        return {
            status: 'not-required',
            message: 'Accessibility permission is not required on this platform',
        };
    }
    if (!systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') {
        return {
            status: 'restricted',
            message: 'Accessibility permission status is unavailable in this Electron runtime',
        };
    }
    if (systemPreferences.isTrustedAccessibilityClient(false)) {
        return { status: 'granted', message: 'Permission already granted' };
    }
    const granted = systemPreferences.isTrustedAccessibilityClient(true);
    return granted
        ? { status: 'granted', message: 'Permission granted' }
        : {
            status: 'denied',
            message: 'Permission not granted. Please enable Accessibility in System Settings → Privacy & Security → Accessibility.',
        };
}
/**
 * Open macOS System Settings to the Screen Recording permission page.
 */
export function openScreenRecordingSettings() {
    if (process.platform !== 'darwin')
        return;
    shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
}
/**
 * Open the Screen Recording page after first making a best-effort capture
 * probe. This gives macOS a chance to create the app's TCC row, which is what
 * lets the user flip the switch directly after the settings page opens.
 */
export async function openScreenRecordingSettingsForGrant() {
    if (process.platform !== 'darwin')
        return;
    const current = getScreenPermissionStatus();
    if (current !== 'granted' && current !== 'restricted') {
        try {
            await primeScreenRecordingTccRecord();
        }
        catch (err) {
            log.warn(`[Screenshot] Failed to prime screen recording TCC record before settings: ${err}`);
        }
    }
    openScreenRecordingSettings();
}
export function openAccessibilitySettings() {
    if (process.platform !== 'darwin')
        return;
    void shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
}
export async function requestComputerUsePermission(kind) {
    if (kind === 'screen-recording')
        return requestScreenPermission();
    if (kind === 'accessibility')
        return requestAccessibilityPermission();
    throw new Error('computer_permission_kind_invalid');
}
export async function openComputerUsePermissionSettings(kind) {
    if (kind === 'screen-recording') {
        await openScreenRecordingSettings();
        return;
    }
    if (kind === 'accessibility') {
        openAccessibilitySettings();
        return;
    }
    throw new Error('computer_permission_kind_invalid');
}
