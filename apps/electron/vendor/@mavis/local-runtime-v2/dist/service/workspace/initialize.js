import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
import { WorkspaceHtmlPreviewService } from './html-preview.service.js';
import { WorkspaceFileServiceImpl } from './orchestration/workspace-file.service.js';
import { WorkspaceGitService } from './orchestration/workspace-git.service.js';
import { WorkspaceIndexingServiceImpl } from './orchestration/workspace-indexing.service.js';
import { WorkspaceLocalActionsServiceImpl } from './orchestration/workspace-local-actions.service.js';
function initializeWorkspaceHtmlPreviewService() {
    return new WorkspaceHtmlPreviewService();
}
/** @internal Component constructor used by runtime composition. */
export function initializeWorkspaceGitService(options = {}) {
    return new WorkspaceGitService(options);
}
/** @internal Component constructor used by runtime composition. */
export function initializeWorkspaceFileService(options = {}) {
    return new WorkspaceFileServiceImpl(options);
}
/** @internal Component constructor used by runtime composition. */
export function initializeWorkspaceIndexingService(options) {
    return new WorkspaceIndexingServiceImpl(options);
}
/** @internal Component constructor used by runtime composition. */
export function initializeWorkspaceLocalActionsService(options = {}) {
    return new WorkspaceLocalActionsServiceImpl(options);
}
function initializeWorkspaceSystem(options) {
    const git = initializeWorkspaceGitService(options.git);
    const file = initializeWorkspaceFileService({
        runFileMutation: (workspace, operation) => git.runFileMutation(workspace, operation),
        ...options.file,
    });
    return {
        git,
        indexing: initializeWorkspaceIndexingService(options.indexing),
        htmlPreview: initializeWorkspaceHtmlPreviewService(),
        file,
        localActions: initializeWorkspaceLocalActionsService(options.localActions),
    };
}
export function initializeRuntimeWorkspaceServices(options, publishChanged) {
    const localActionsPort = options.runtimeOwnerKind === undefined || options.runtimeOwnerKind === 'electron'
        ? options.compatibility.workspaceLocalActions
        : undefined;
    return initializeWorkspaceSystem({
        git: {
            publishChanged,
            ...(options.compatibility.listRunningWorktreeDirs
                ? { listRunningWorktreeDirs: options.compatibility.listRunningWorktreeDirs }
                : {}),
        },
        indexing: {
            preferences: {
                get: async (key) => readPreferenceValue(options.db, key),
                set: async (key, value) => upsertPreferenceValue(options.db, key, value),
            },
            ...(options.getSession ? { getSession: options.getSession } : {}),
            ...(options.compatibility.workspaceIndexing
                ? { worker: options.compatibility.workspaceIndexing }
                : {}),
            // Indexing requires an explicit user opt-in on every host and build.
            forced: false,
        },
        localActions: localActionsPort ? { port: localActionsPort } : {},
    });
}
//# sourceMappingURL=initialize.js.map