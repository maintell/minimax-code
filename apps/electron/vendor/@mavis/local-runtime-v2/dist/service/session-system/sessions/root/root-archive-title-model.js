export class RootArchiveTitleModelError extends Error {
    stage;
    cause;
    constructor(stage, message, cause) {
        super(message);
        this.stage = stage;
        this.cause = cause;
        this.name = 'RootArchiveTitleModelError';
    }
}
//# sourceMappingURL=root-archive-title-model.js.map