import { session } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "../browser/controller";
import { BrowserProfileImportService } from "./browser-profile-import-service";
import { readChromeCookies } from "./chrome-cookie-reader";
import { isChromeInstalled, discoverChromeProfiles } from "./chrome-profile";
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
        discoverProfiles: (context) => discoverChromeProfiles({ ...context, onDiagnostic: reportBrowserProfileImportDiagnostic }),
        readCookies: (profile, signal, context) => readChromeCookies(profile, signal, {
            currentHost: context.currentHost,
            requestId: context.requestId,
            onAuthorizationRequired: context.onAuthorizationRequired,
            onAuthorizationCompleted: context.onAuthorizationCompleted,
            onDiagnostic: reportBrowserProfileImportDiagnostic,
        }),
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

