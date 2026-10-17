/**
 * Path resolution for local-shell handlers. Wraps `path-guard` with a
 * typed error so the dispatcher can distinguish "user tried to escape
 * the workspace" (fall back to sandbox, which has its own containment)
 * from generic fs failures (ENOENT, EACCES — handler renders stderr).
 *
 * Local handlers do NOT expand `~`; the parser keeps tilde as a literal
 * character, and the dispatcher rejects argv entries starting with `~`
 * so the sandbox shell handles user-dir expansion canonically.
 */
import { resolveWithinWorkspace } from '../path-guard.js';
export class LocalShellPathError extends Error {
    target;
    constructor(target, cause) {
        super(`local-shell: path escapes workspace: ${target}`);
        this.target = target;
        this.name = 'LocalShellPathError';
        if (cause instanceof Error) {
            this.stack = `${this.stack}\nCaused by: ${cause.stack ?? cause.message}`;
        }
    }
}
/**
 * Resolve a user-provided path into an absolute path inside the
 * workspace. Throws `LocalShellPathError` when the path escapes the
 * workspace (after realpath resolution to defeat symlink tricks).
 * Other fs errors propagate untouched — handlers translate them into
 * stderr / non-zero exit codes locally.
 */
export async function resolveLocalShellPath(argPath, workspaceRoot) {
    try {
        return await resolveWithinWorkspace(argPath, workspaceRoot);
    }
    catch (err) {
        // path-guard throws a plain Error whose message starts with
        // "Workspace path escapes Cloud Host root". Anything else (e.g.
        // permission errors reading the symlink target) we still treat as
        // a path-escape: handlers cannot safely continue without a verified
        // path, so the dispatcher will fall back to the sandbox.
        throw new LocalShellPathError(argPath, err);
    }
}
//# sourceMappingURL=path-resolve.js.map