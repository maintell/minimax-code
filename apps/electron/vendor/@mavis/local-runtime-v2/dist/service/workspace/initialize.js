import { WorkspaceHtmlPreviewService } from './html-preview.service.js';
import { WorkspaceIndexing, } from './indexing.js';
import { WorkspaceGitService } from './workspace-git.service.js';
function initializeWorkspaceHtmlPreviewService() {
    return new WorkspaceHtmlPreviewService();
}
function initializeWorkspaceGitService(options = {}) {
    return new WorkspaceGitService(options);
}
export function initializeWorkspaceSystem(options) {
    return {
        git: initializeWorkspaceGitService(options.git),
        indexing: new WorkspaceIndexing(options.indexingPolicy, options.indexingExecutor),
        htmlPreview: initializeWorkspaceHtmlPreviewService(),
    };
}
//# sourceMappingURL=initialize.js.map