import { WorkspaceIndexingControllerBase } from '../generated/workspace-indexing-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
export class WorkspaceIndexingController extends WorkspaceIndexingControllerBase {
    indexing;
    constructor(indexing) {
        super();
        this.indexing = indexing;
    }
    async prewarmWorkspaceIndexing(ctx, req) {
        void ctx;
        if (!this.indexing)
            throw new NotImplementedError('prewarmWorkspaceIndexing');
        const workspaceDir = req.workspaceDir.trim();
        if (!workspaceDir) {
            throw new AppError(400, 'INVALID_WORKSPACE_DIR', 'workspace_dir must not be empty');
        }
        await this.indexing.prewarm(workspaceDir);
        return { scheduled: true };
    }
}
//# sourceMappingURL=workspace-indexing.controller.js.map