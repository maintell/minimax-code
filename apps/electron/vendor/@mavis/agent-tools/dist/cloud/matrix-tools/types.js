export class MatrixMediaError extends Error {
    kind;
    underlying;
    constructor(kind, message, underlying) {
        super(message);
        this.kind = kind;
        this.name = 'MatrixMediaError';
        if (underlying !== undefined)
            this.underlying = underlying;
    }
}
export function readMatrixMediaErrorKind(err) {
    if (err instanceof MatrixMediaError)
        return err.kind;
    if (err && typeof err === 'object') {
        const kind = err.kind;
        return typeof kind === 'string' ? kind : undefined;
    }
    return undefined;
}
//# sourceMappingURL=types.js.map