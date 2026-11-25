import { readSessionAdditionalWorkspaceRoots, } from '../../service/session-system/index.js';
/** Bounds the walk over stored parent links, which nothing keeps acyclic. */
const MAX_TASK_DEPTH = 32;
/**
 * Binds the per-Turn reader of a Session's additional Project folders.
 *
 * Only the Desktop owner has Projects with additional folders. TUI, CLI and
 * app-server (ACP) sessions stay scoped to the folder they run in, even when
 * that folder is a Desktop Project's primary folder: their prompt, sandbox and
 * permission checks all read the same empty snapshot.
 */
export function bindProjectAdditionalWorkspaceRoots(input) {
    if (input.runtimeOwnerKind !== 'electron')
        return;
    input.preparation.bindAdditionalWorkspaceRoots(async (sessionId) => readSessionAdditionalWorkspaceRoots(input.projects, await projectOwnerSessionId(input.sessions, sessionId)));
}
/**
 * A task runs in its parent's folder, but its own row maps that folder to a
 * Project: for a worktree outside the repository that is not the parent's. The
 * Session that started the task decides which folders it gets.
 */
async function projectOwnerSessionId(sessions, sessionId) {
    let current = sessionId;
    for (let depth = 0; depth < MAX_TASK_DEPTH; depth += 1) {
        const session = await sessions.get(current);
        if (session?.sessionKind !== 'task' || !session.parentSessionId)
            return current;
        current = session.parentSessionId;
    }
    return current;
}
//# sourceMappingURL=project-workspace-roots-binding.js.map