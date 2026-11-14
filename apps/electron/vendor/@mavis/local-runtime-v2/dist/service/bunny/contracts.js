import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
export { BUNNY_AGENT_NAME };
/** Bunny's root conversation delivers into its task-space library. */
export const BUNNY_LIBRARY_ROOT_AGENTS = [BUNNY_AGENT_NAME];
export const BUNNY_TEMPLATE_VERSION = 'v0.0.12';
/**
 * Permission mode for Bunny and the task sessions it assigns. `follow` uses the
 * global mode the user picks in an ordinary composer.
 */
const BUNNY_PERMISSION_MODES = ['follow', 'default', 'auto', 'bypassPermissions'];
export function isBunnyPermissionMode(value) {
    return BUNNY_PERMISSION_MODES.some((mode) => mode === value);
}
/** No complete backup with this ID in `<dataDir>/bunny-backups/`. */
export class BunnyBackupNotFoundError extends Error {
    code = 'BUNNY_BACKUP_NOT_FOUND';
}
/** A task model the save refused; the message carries the model and the reason. */
export class BunnyTaskModelInvalidError extends Error {
    code = 'BUNNY_TASK_MODEL_INVALID';
}
//# sourceMappingURL=contracts.js.map