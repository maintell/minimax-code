export class ArtifactCatalogError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
//# sourceMappingURL=errors.js.map