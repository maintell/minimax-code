export class WorkspaceGitGraphError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'WorkspaceGitGraphError';
    }
}
export class WorkspaceReviewSearchTooLargeError extends Error {
    reason;
    name = 'WorkspaceReviewSearchTooLargeError';
    constructor(reason) {
        super('Review search exceeded its safe in-memory index budget');
        this.reason = reason;
    }
}
export class WorkspaceGitSnapshotChangedError extends Error {
    snapshotId;
    name = 'WorkspaceGitSnapshotChangedError';
    constructor(snapshotId) {
        super('Workspace Git snapshot changed while the requested content was being generated');
        this.snapshotId = snapshotId;
    }
}
export class WorkspaceGitCommandError extends Error {
    operation;
    exitCode;
    name = 'WorkspaceGitCommandError';
    constructor(operation, exitCode, details) {
        super(`Git ${operation} failed with exit code ${exitCode}: ${details || 'unknown error'}`);
        this.operation = operation;
        this.exitCode = exitCode;
    }
}
//# sourceMappingURL=contracts.js.map