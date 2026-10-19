import { getCategoryLogger } from "../../utils/logger";
const diagnosticLogger = getCategoryLogger('main', 'browser-profile-import');
/**
 * Persist only the typed, aggregate import lifecycle events. The event union intentionally has no
 * profile path, host, Cookie name/value, Safe Storage secret, or decrypted payload fields.
 */
export const reportBrowserProfileImportDiagnostic = (diagnostic) => {
    try {
        diagnosticLogger.info({
            msg: `[BrowserProfileImport] ${diagnostic.event}`,
            ...diagnostic,
        });
    }
    catch {
        // Persisted diagnostics are best-effort and must never affect the import flow.
    }
};

