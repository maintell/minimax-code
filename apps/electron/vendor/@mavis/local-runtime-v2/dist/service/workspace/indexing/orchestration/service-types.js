export class WorkspaceInitialSnapshotError extends Error {
    code = 'workspace_initial_snapshot_failed';
    constructor(options) {
        super('The workspace Initial Snapshot could not be created.', options);
        this.name = 'WorkspaceInitialSnapshotError';
    }
}
//# sourceMappingURL=service-types.js.map