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
//# sourceMappingURL=reader-errors.js.map