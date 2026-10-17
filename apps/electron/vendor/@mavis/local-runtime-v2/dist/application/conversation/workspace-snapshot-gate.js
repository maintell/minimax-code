export const WORKSPACE_INITIAL_SNAPSHOT_FAILED = 'workspace_initial_snapshot_failed';
export const WORKSPACE_INITIAL_SNAPSHOT_FAILED_MESSAGE = 'Failed to capture the workspace before Agent startup.';
/** Marks a pre-delivery gate failure for the synchronous SSE-open mapper. */
export class WorkspaceInitialSnapshotGateError extends Error {
    constructor(options) {
        super(WORKSPACE_INITIAL_SNAPSHOT_FAILED_MESSAGE, options);
        this.name = 'WorkspaceInitialSnapshotGateError';
    }
}
//# sourceMappingURL=workspace-snapshot-gate.js.map