export function readSessionCreateScope(args) {
    const project = nonBlank(Reflect.get(args, 'project'));
    const workspaceDir = nonBlank(Reflect.get(args, 'workspace_dir'));
    if (project !== undefined && workspaceDir !== undefined)
        return { kind: 'both' };
    if (project !== undefined)
        return { kind: 'project', value: project };
    if (workspaceDir !== undefined)
        return { kind: 'workspace_dir', value: workspaceDir };
    const worktreeDir = existingWorktreeDir(Reflect.get(args, 'location'));
    return worktreeDir === undefined
        ? { kind: 'none' }
        : { kind: 'worktree_dir', value: worktreeDir };
}
/** Whether the call names a scope, which is what asks the user to approve that project. */
export function namesSessionCreateScope(args) {
    const { kind } = readSessionCreateScope(args);
    return kind !== 'none' && kind !== 'both';
}
function existingWorktreeDir(location) {
    if (typeof location !== 'object' || location === null)
        return undefined;
    if (Reflect.get(location, 'mode') !== 'existing_worktree')
        return undefined;
    return nonBlank(Reflect.get(location, 'worktree_dir'));
}
function nonBlank(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
//# sourceMappingURL=session-create-scope.js.map