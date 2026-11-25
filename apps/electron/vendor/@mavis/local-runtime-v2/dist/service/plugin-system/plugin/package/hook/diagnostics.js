export function projectPluginHookDiagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        capability: diagnostic.code === 'HOOK_MODULES_INVALID' ? 'EXTENSION' : 'HOOK',
        name: diagnostic.event ?? diagnostic.sourcePath,
        ...(diagnostic.fix ? { fix: diagnostic.fix } : {}),
    }));
}
//# sourceMappingURL=diagnostics.js.map