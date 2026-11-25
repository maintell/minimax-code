export const DEFAULT_WORKTREE_KEEP_COUNT = 15;
/** A keep count is a positive safe integer; the same rule validates writes and reads. */
export function isWorktreeKeepCount(raw) {
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1;
}
/** Invalid or non-positive values fall back to the default keep count. */
export function parseWorktreeKeepCount(raw) {
    return isWorktreeKeepCount(raw) ? raw : DEFAULT_WORKTREE_KEEP_COUNT;
}
/** Missing keys resolve to the defaults: refresh on, cleanup off, keep 15. */
export function parseWorktreeConfig(raw) {
    return {
        worktreeRefreshBeforeCreate: raw.worktreeRefreshBeforeCreate !== false,
        worktreeAutoCleanupEnabled: raw.worktreeAutoCleanupEnabled === true,
        worktreeKeepCount: parseWorktreeKeepCount(raw.worktreeKeepCount),
    };
}
//# sourceMappingURL=worktree-config.js.map