export function projectPluginHookDiagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        capability: 'HOOK',
        name: diagnostic.event ?? diagnostic.sourcePath,
    }));
}
//# sourceMappingURL=diagnostics.js.map