/** Stable identity for the process-owned local Desktop Runtime. */
export const LOCAL_DESKTOP_RUNTIME_ID = 'local';
/** Namespace for runtimes owned by persisted SSH projects. */
export const SSH_PROJECT_RUNTIME_ID_PREFIX = 'ssh-project:';
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/**
 * Remote Runtime business feature declared in the SSH app-server initialize
 * result. A transport handshake alone never implies this feature.
 */
export const RUNTIME_FEATURE_PROJECT_ICON_UPDATE = 'project.icon.update';
/**
 * Remote Computer Use on the SSH host. Declared only when the remote app-server
 * owns a Computer Use client; permissions are granted on that host only.
 */
export const RUNTIME_FEATURE_COMPUTER_USE = 'computer.use';
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