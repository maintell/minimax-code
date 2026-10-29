/** Stable identity for the process-owned local Desktop Runtime. */
export const LOCAL_DESKTOP_RUNTIME_ID = 'local';
/** Namespace for runtimes owned by persisted SSH projects. */
export const SSH_PROJECT_RUNTIME_ID_PREFIX = 'ssh-project:';
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function sshProjectRuntimeId(projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
        throw new Error('invalid_ssh_project_id');
    }
    return `${SSH_PROJECT_RUNTIME_ID_PREFIX}${projectId}`;
}
export function sshProjectIdFromRuntimeId(runtimeId) {
    if (!runtimeId.startsWith(SSH_PROJECT_RUNTIME_ID_PREFIX))
        return null;
    const projectId = runtimeId.slice(SSH_PROJECT_RUNTIME_ID_PREFIX.length);
    return PROJECT_ID_PATTERN.test(projectId) ? projectId : null;
}
export function isDesktopRuntimeId(value) {
    return (value === LOCAL_DESKTOP_RUNTIME_ID ||
        (typeof value === 'string' && sshProjectIdFromRuntimeId(value) !== null));
}
//# sourceMappingURL=desktop-runtime.js.map