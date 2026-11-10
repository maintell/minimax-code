export const LOCAL_MEMORY_TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export class LocalMemoryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LocalMemoryError';
    }
}
//# sourceMappingURL=types.js.map