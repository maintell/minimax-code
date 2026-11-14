/** Workspace owners the prompt-bound owners read: indexing, and git for Next Step actions. */
export function promptBoundWorkspaceInputs(workspace) {
    return { workspaceIndexing: workspace.indexing, nextStepWorkspaceGit: workspace.git };
}
/** Workspace owners the service lifecycle closes and recovers through. */
export function workspaceLifecycleInputs(workspace) {
    return {
        workspaceGit: workspace.git,
        workspaceHtmlPreview: workspace.htmlPreview,
        workspaceFile: workspace.file,
        workspaceIndexing: workspace.indexing,
    };
}
//# sourceMappingURL=runtime-workspace-inputs.js.map