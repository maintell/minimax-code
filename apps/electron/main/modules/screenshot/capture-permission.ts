import { app } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { ComputerUsePermissionGuide } from "./permission-guide";
import { getScreenPermissionStatus, primeScreenRecordingTccRecord, openScreenRecordingSettingsForGrant } from "./permission";
const log = getCategoryLogger('main');
let guide;
let generation = 0;
export function closeScreenCaptureGuide() {
    generation++;
    guide?.close();
    guide = undefined;
}
/**
 * Screen Recording gate checked on every capture click (macOS only).
 *
 * Chromium reports an app that was never asked as "denied", so a real capture probe runs first:
 * the first time, macOS shows its own authorization prompt and lists this app on the Screen
 * Recording page. macOS never reports the user's answer and a new grant only applies after the
 * app reopens, so any other result brings the calling window forward for the composer to explain
 * that capture is unavailable.
 */
export async function ensureScreenCapturePermission(owner) {
    if (process.platform !== 'darwin')
        return 'granted';
    let status = getScreenPermissionStatus();
    if (status === 'granted' || status === 'not-required')
        return 'granted';
    if (status !== 'restricted') {
        try {
            await primeScreenRecordingTccRecord();
        }
        catch (error) {
            log.warn(`[Screenshot] Screen recording probe failed: ${error}`);
        }
        status = getScreenPermissionStatus();
        if (status === 'granted')
            return 'granted';
    }
    log.info(`[Screenshot] Capture unavailable without screen recording permission: ${status}`);
    // The click may come from the global shortcut while another app is in front.
    if (!owner.isDestroyed()) {
        app.focus({ steal: true });
        if (owner.isMinimized())
            owner.restore();
        owner.show();
        owner.focus();
    }
    return status === 'restricted' ? 'restricted' : 'denied';
}
/**
 * Same recovery as the Computer Use live preview, which relies on this app's own grant too:
 * list the app, open the Screen Recording page and show the drag guide for this app.
 */
export async function openScreenCaptureSettings() {
    if (process.platform !== 'darwin')
        return;
    const current = generation;
    await openScreenRecordingSettingsForGrant();
    if (current !== generation)
        return;
    guide ?? (guide = new ComputerUsePermissionGuide('desktop'));
    // Guidance must not block the settings navigation.
    await guide
        .show('screen-recording')
        .catch((error) => log.warn(`[Screenshot] Permission guide unavailable: ${error}`));
}
