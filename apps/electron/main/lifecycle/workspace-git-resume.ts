/**
 * A sleeping process cannot prove that every filesystem event was delivered.
 * Resume therefore starts a new runtime-owned Git snapshot generation instead
 * of letting the renderer guess which workspaces may have changed.
 */
export async function invalidateWorkspaceGitSnapshotsAfterResume(invoke) {
    const response = await invoke(new Request('http://127.0.0.1/minimax-desktop/api/v1/file/git/invalidate-all', {
        method: 'POST',
    }));
    if (!response.ok) {
        throw new Error(`Workspace Git snapshot invalidation failed with ${response.status}`);
    }
}
