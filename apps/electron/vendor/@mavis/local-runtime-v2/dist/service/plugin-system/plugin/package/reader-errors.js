const MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS = 32;
export class PluginReaderError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.name = 'PluginReaderError';
    }
}
export function readerFail(code, detail) {
    throw new PluginReaderError(code, detail);
}
/**
 * Newer packages may declare manifest fields this client does not understand.
 * They are ignored instead of rejecting the package; diagnostics name the field
 * only, never its value, and are capped per package.
 */
export function ignoredManifestFieldDiagnostics(manifest, knownFields) {
    const fields = Object.keys(manifest).filter((field) => !knownFields.has(field));
    const diagnostics = fields
        .slice(0, MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS)
        .map((field) => ({ code: 'MANIFEST_UNKNOWN_FIELD_IGNORED', name: field }));
    if (fields.length > MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS) {
        diagnostics.push({ code: 'MANIFEST_UNKNOWN_FIELDS_TRUNCATED' });
    }
    return diagnostics;
}
//# sourceMappingURL=reader-errors.js.map