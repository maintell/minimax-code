/**
 * Shares only work that is still in flight. Completed values are deliberately
 * not retained, so a later request always observes a fresh Git snapshot.
 */
export class WorkspaceGitChangesCoordinator {
    loadBase;
    loadFull;
    baseRequests = new Map();
    fullRequests = new Map();
    constructor(loadBase, loadFull) {
        this.loadBase = loadBase;
        this.loadFull = loadFull;
    }
    getChanges(workspace, mode) {
        if (mode === 'fast') {
            // A full request owns the same base snapshot for its entire lifetime.
            // Reuse it even after the base promise has settled but enrichment is
            // still running.
            const fullRequest = this.fullRequests.get(workspace);
            if (fullRequest) {
                return fullRequest.base;
            }
            return this.getBase(workspace);
        }
        const existing = this.fullRequests.get(workspace);
        if (existing) {
            return existing.result;
        }
        const base = this.getBase(workspace);
        const result = base.then((snapshot) => this.loadFull(workspace, snapshot));
        const request = { base, result };
        this.fullRequests.set(workspace, request);
        this.clearAfterSettled(this.fullRequests, workspace, request, result);
        return result;
    }
    /**
     * Detaches every in-flight snapshot for one workspace. Existing callers may
     * still finish, but requests that start after this barrier cannot join those
     * pre-mutation promises.
     */
    invalidate(workspace) {
        this.baseRequests.delete(workspace);
        this.fullRequests.delete(workspace);
    }
    clear() {
        this.baseRequests.clear();
        this.fullRequests.clear();
    }
    getBase(workspace) {
        const existing = this.baseRequests.get(workspace);
        if (existing) {
            return existing;
        }
        const request = Promise.resolve().then(() => this.loadBase(workspace));
        this.baseRequests.set(workspace, request);
        this.clearAfterSettled(this.baseRequests, workspace, request, request);
        return request;
    }
    clearAfterSettled(requests, workspace, entry, settled) {
        const clear = () => {
            if (requests.get(workspace) === entry)
                requests.delete(workspace);
        };
        void settled.then(clear, clear);
    }
}
//# sourceMappingURL=workspace-git-changes-coordinator.js.map