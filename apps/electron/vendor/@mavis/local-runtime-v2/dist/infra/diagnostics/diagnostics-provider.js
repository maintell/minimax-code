export function hostDiagnosticsUnavailable(capability) {
    return {
        available: false,
        error: 'host_diagnostics_unavailable',
        capability,
        reason: 'No host diagnostics provider is registered for this local runtime owner.',
    };
}
//# sourceMappingURL=diagnostics-provider.js.map