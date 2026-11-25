const SILENT_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
};
let sink = SILENT_LOGGER;
/** Installs the Host diagnostic sink; an absent logger restores the silent default. */
export function configureContextUsageDiagnosticsLogger(logger) {
    sink = logger ?? SILENT_LOGGER;
}
/** Every Context Usage diagnostic goes through here; a failing sink is swallowed. */
export const contextUsageDiagnostics = {
    info: (fields, message) => {
        try {
            sink.info(fields, message);
        }
        catch {
            // Diagnostics must never affect the owning Turn.
        }
    },
    warn: (fields, message) => {
        try {
            sink.warn(fields, message);
        }
        catch {
            // Diagnostics must never affect the owning Turn.
        }
    },
};
//# sourceMappingURL=context-usage-diagnostics.js.map