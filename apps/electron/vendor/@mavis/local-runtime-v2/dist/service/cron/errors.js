export class CronRepositoryError extends Error {
    code;
    name = 'CronRepositoryError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map