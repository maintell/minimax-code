export class ComputerUseError extends Error {
    code;
    completion;
    name = 'ComputerUseError';
    constructor(code, message, completion = 'not_started') {
        super(`${code}: ${message}`);
        this.code = code;
        this.completion = completion;
    }
}
export function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
export function structured(value) {
    const outer = record(value);
    if (outer?.isError)
        return undefined;
    const data = outer?.structuredJson ?? outer?.structuredContent ?? outer?.rawJson;
    try {
        return typeof data === 'string' ? record(JSON.parse(data)) : record(data);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=contracts.js.map