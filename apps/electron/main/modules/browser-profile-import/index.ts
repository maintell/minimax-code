import { session } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "../browser/controller";
import { createWindowsAbeImportRuntime } from "./abe-windows-import";
import { BrowserProfileImportService } from "./browser-profile-import-service";
import { readChromeCookies } from "./chrome-cookie-reader";
import { isChromeInstalled, isCookieDatabaseLocked, discoverChromeProfiles } from "./chrome-profile";
import { reportBrowserProfileImportDiagnostic } from "./diagnostics";
const progressListeners = new Set();
let service = null;
export function subscribeBrowserProfileImportProgress(listener) {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
}
export function getBrowserProfileImportService() {
    if (service)
        return service;
    const browserSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
    service = new BrowserProfileImportService({
        platform: process.platform,
        isChromeInstalled: isChromeInstalled,
        isCookieDatabaseLocked: isCookieDatabaseLocked,
        discoverProfiles: (context) => discoverChromeProfiles({ ...context, onDiagnostic: reportBrowserProfileImportDiagnostic }),
        readCookies: async (profile, signal, context) => {
            // One runtime per import: the broker session it owns is what makes the
            // whole import cost a single UAC prompt, and closing it is what makes the
            // broker stop and delete the shadow copies it created. Both properties
            // depend on this object living exactly as long as one read.
            const windowsAbe = createWindowsAbeImportRuntime({
                requestId: context.requestId,
                onDiagnostic: reportBrowserProfileImportDiagnostic,
            });
            try {
                return await readChromeCookies(profile, signal, {
                    currentHost: context.currentHost,
                    requestId: context.requestId,
                    onAuthorizationRequired: context.onAuthorizationRequired,
                    onAuthorizationCompleted: context.onAuthorizationCompleted,
                    onDiagnostic: reportBrowserProfileImportDiagnostic,
                    // Absent on non-Windows and in builds without the broker binary. The
                    // reader then treats v20 records as unsupported, which is the
                    // behaviour that existed before this feature.
                    getWindowsAppBoundKey: windowsAbe?.getAppBoundKey,
                    createWindowsShadowSnapshot: windowsAbe?.createShadowSnapshot,
                });
            }
            finally {
                windowsAbe?.close();
            }
        },
        setCookie: (cookie) => browserSession.cookies.set(cookie),
        flushCookies: () => browserSession.cookies.flushStore(),
        onProgress: (progress) => {
            for (const listener of progressListeners)
                listener(progress);
        },
        onDiagnostic: reportBrowserProfileImportDiagnostic,
    });
    return service;
}
export { reportBrowserProfileImportDiagnostic } from "./diagnostics";

